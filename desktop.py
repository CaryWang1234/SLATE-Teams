import argparse
import json
import signal
import sys
import subprocess
import time
import webview
import os
import atexit
import urllib.request
import socket
import threading
from html import escape as html_escape

import desktop_tray
import desktop_instance
import desktop_platform

# 获取当前文件所在目录，方便后续路径
FROZEN = getattr(sys, 'frozen', False)
BASE_DIR = os.path.dirname(sys.executable) if FROZEN else os.path.dirname(os.path.abspath(__file__))
# 三个路径由平台助手现算，不在这里写死拼接：Mac 装机版的数据与日志落进 .app 就等于是
# 一次"升级即丢 Key"，见 desktop_platform 模块说明。
_PATHS = desktop_platform.bundle_paths(BASE_DIR, os.path.expanduser('~'), sys.platform, FROZEN)
DATA_DIR = _PATHS['data_dir']
LOG_PATH = _PATHS['log_path']
STORAGE_PATH = _PATHS['storage_path']
WINDOW_TITLE = 'SLATE Teams'

# Mac 装机版的 data 目录是第一次启动才有的，而 main() 上来就 open(LOG_PATH, 'w') 清空日志——
# 目录不在就是 FileNotFoundError，窗口还没起进程就没了。Windows 与源码态这里是个 no-op。
os.makedirs(DATA_DIR, exist_ok=True)

# 锁要活得和进程一样久：句柄在，别人才会在双击第二份时判定"已有实例"。
# 放模块全局而不是局部量，是为了让"谁持着闸门"这件事在代码里读得出来
_instance_lock = None


def _find_icon():
    """托盘要用 app.ico：打包后它随 datas 落在 _internal 根，源码态就在仓库根。"""
    roots = []
    if getattr(sys, 'frozen', False):
        roots.append(getattr(sys, '_MEIPASS', ''))
    roots += [BASE_DIR, os.path.dirname(os.path.abspath(__file__))]
    for root in roots:
        if not root:
            continue
        path = os.path.join(root, 'app.ico')
        if os.path.exists(path):
            return path
    return None


def log(message):
    timestamp = time.strftime('%Y-%m-%d %H:%M:%S')
    with open(LOG_PATH, 'a', encoding='utf-8') as f:
        f.write(f'[{timestamp}] {message}\n')
        f.flush()

# 前端 API 类（供 JavaScript 调用）
class Api:
    def __init__(self, window, process):
        self.window = window
        self.process = process

    def quit(self):
        """关闭窗口并终止 uvicorn 进程"""
        stop_process(self.process)
        self.window.destroy()

def get_free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]

def can_reuse_server(url):
    try:
        with urllib.request.urlopen(f'{url}/api/proxy/models', timeout=1) as response:
            return response.status == 200
    except Exception:
        return False

def is_port_free(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        return sock.connect_ex(('127.0.0.1', port)) != 0

def start_uvicorn(port):
    """
    在子进程中启动 uvicorn 服务器
    注意：必须指定 main:app，假设 main.py 中有 app 对象
    """
    log_file = open(LOG_PATH, 'a', encoding='utf-8')
    cmd = [
        sys.executable, '-m', 'uvicorn',
        'backend.main:app',
        '--host', '127.0.0.1',
        '--port', str(port),
        '--log-level', 'info'
    ]
    log('starting backend: ' + ' '.join(cmd))
    startupinfo = None
    creationflags = 0
    if os.name == 'nt':
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        creationflags = subprocess.CREATE_NO_WINDOW
    process = subprocess.Popen(
        cmd,
        cwd=BASE_DIR,
        stdout=log_file,
        stderr=log_file,
        startupinfo=startupinfo,
        creationflags=creationflags,
    )
    process._slate_log_file = log_file
    return process

def start_embedded_uvicorn(port):
    os.environ['SLATE_DATA_DIR'] = DATA_DIR
    log_file = open(LOG_PATH, 'a', encoding='utf-8')
    log(f'starting embedded backend on port {port}')

    def run():
        try:
            sys.stdout = log_file
            sys.stderr = log_file
            import uvicorn
            from backend.main import app
            config = uvicorn.Config(app, host='127.0.0.1', port=port, log_level='info')
            server = uvicorn.Server(config)
            thread.server = server
            server.run()
        except Exception as exc:
            log(f'embedded backend crashed: {exc}')
        finally:
            log_file.flush()

    thread = threading.Thread(target=run, daemon=True)
    thread._slate_log_file = log_file
    thread.server = None
    thread.start()
    return thread

def wait_for_server(process, url, timeout=20):
    deadline = time.time() + timeout
    last_error = None
    while time.time() < deadline:
        if hasattr(process, 'poll') and process.poll() is not None:
            return False, f'backend exited with code {process.returncode}'
        try:
            with urllib.request.urlopen(f'{url}/api/proxy/models', timeout=1) as response:
                if response.status == 200:
                    log(f'backend ready: {url}')
                    return True, ''
        except Exception as exc:
            last_error = exc
        time.sleep(0.3)
    return False, str(last_error) if last_error else 'timeout'

def stop_process(process):
    if not process:
        return
    log('stopping backend')
    if isinstance(process, threading.Thread):
        # embedded 模式：线程可能在 server 赋值前异常退出（server 为 None），
        # 此时对它调 poll() 会 AttributeError；这里统一走线程分支
        server = getattr(process, 'server', None)
        if server is not None:
            try:
                server.should_exit = True
            except Exception:
                pass
        process.join(timeout=5)
        log_file = getattr(process, '_slate_log_file', None)
        if log_file:
            try:
                log_file.close()
            except Exception:
                pass
        return
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
    log_file = getattr(process, '_slate_log_file', None)
    if log_file:
        log_file.close()

class TrayHandle:
    """窗口与托盘之间的接线。attach_tray() 造它，主循环走完后调 shutdown() 摘图标。

    口径：点 X 不再停机，窗口缩进系统通知区域继续跑（后端就在本进程/子进程里，
    手机端局域网连接也不断）；只有托盘菜单里的「退出」才真退。托盘起不来（非
    Windows、或这个会话根本没有通知区域）时退回"关窗即退出"的老行为。
    """

    def __init__(self, window, log=lambda message: None):
        self.window = window
        self.log = log
        self.tray = None
        self.quitting = threading.Event()
        self.hinted = threading.Event()

    def show(self):
        try:
            self.window.show()
            self.window.restore()  # 最小化过的那条路：只 Show 会把窗口留在任务栏下面
        except Exception as exc:
            self.log(f'tray show failed: {exc}')

    def request_quit(self):
        self.quitting.set()  # 先立牌：closing 分支才知道这次是真退，不是又要缩起来
        try:
            self.window.destroy()
        except Exception as exc:
            self.log(f'tray quit failed: {exc}')

    def on_closing(self):
        tray_ready = bool(self.tray and self.tray.added())
        # pywebview 只把字面 False 当"取消关闭"，所以走不走托盘必须交给 close_action 判
        if desktop_tray.close_action(self.quitting.is_set(), tray_ready) == 'exit':
            return True
        try:
            self.window.hide()
        except Exception as exc:
            self.log(f'hide to tray failed: {exc}')
            return True  # 藏不起来就别把窗口卡没：让这次关闭照常走完
        if self.tray and not self.hinted.is_set():
            self.hinted.set()  # 只在第一次缩起来时说清去哪儿找回窗口
            self.tray.hint()
        self.log('window hidden to tray')
        return False

    def shutdown(self):
        if self.tray:
            self.tray.stop()
            self.tray = None


def attach_tray(window, log=lambda message: None) -> TrayHandle:
    handle = TrayHandle(window, log)
    handle.window.events.closing += handle.on_closing
    if desktop_tray.available():
        tray = desktop_tray.Tray(
            icon_path=_find_icon(),
            on_show=handle.show,
            on_quit=handle.request_quit,
            text=desktop_tray.labels(desktop_tray.read_lang(DATA_DIR)),
        )
        if tray.start():
            handle.tray = tray
        else:
            log('tray unavailable; closing the window exits as before')
    return handle

# ── --remote：无界面模式 ─────────────────────────────────────
# 没有桌面环境的机器（Linux 服务器、树莓派、容器）上 pywebview 起不来，而遥控真正
# 需要的只是后端与那个局域网副服务。这个模式把它们跑起来、把地址交到终端上，
# 窗口与托盘一概不碰。

REMOTE_READY_TIMEOUT = 20


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        prog='SLATE Teams',
        description='SLATE Teams：不带参数打开主持人窗口；--remote 只起服务，供与会者接入。',
    )
    parser.add_argument(
        '--remote', action='store_true',
        help='不开窗口、不起托盘，只起后端与局域网遥控，并把带授权的遥控地址打印到终端',
    )
    return parser.parse_args(argv)


def _ensure_utf8_stdout():
    """无头 Linux 上 stdout 常是 POSIX locale（ascii），直接写中文会 UnicodeEncodeError
    把进程带走。改成 UTF-8 且编码失败也不抛；没有 reconfigure 的流（比如打包版
    console=False 时的 None）跳过即可。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except (AttributeError, ValueError, OSError):
            pass


def _say(message):
    """远程模式的输出去处：有终端就写终端（无头 Linux 的主用法），没有就落到日志
    ——打包版 console=False，sys.stdout 是 None，直接 print 会把进程干掉。"""
    line = message + '\n'
    stream = sys.stdout
    if stream is not None:
        try:
            stream.write(line)
            stream.flush()
            return
        except (OSError, ValueError):
            pass
    try:
        with open(LOG_PATH, 'a', encoding='utf-8') as f:
            f.write(line)
    except OSError:
        pass


def fetch_lan_info(app_url, timeout=REMOTE_READY_TIMEOUT):
    """从主端口读遥控信息。副服务由后端 startup 起，比主端口就绪略晚，故重试。

    只等到"接口答得上话"为止，不等到"遥控确实在听"：开关关着时后者永远等不来，
    而这个模式该做的是把真实状态说清楚，不是白等 20 秒。
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f'{app_url}/api/lan/info', timeout=1) as response:
                if response.status == 200:
                    payload = json.loads(response.read().decode('utf-8'))
                    data = payload.get('data') if isinstance(payload, dict) else None
                    if isinstance(payload, dict) and payload.get('code') == 0 and isinstance(data, dict):
                        return data
        except Exception:
            pass
        time.sleep(0.3)
    return None


def run_remote(app_url):
    """--remote 的主循环：等 Ctrl+C（或 SIGTERM），返回即收尾。"""
    _ensure_utf8_stdout()
    _say('SLATE Teams 已进入远程模式（无界面）。')
    _say(f'  本机地址：{app_url}')
    info = fetch_lan_info(app_url)
    # 以 urls 为准而不是某个状态字段：有地址就等于副服务真的在听，这一条在新旧后端上
    # 含义一致，读到空串才是真没起来（开关关着、端口没抢到都归这里）。
    urls = (info or {}).get('urls') or []
    if urls:
        for url in urls:
            _say(f'  遥控地址：{url}')
        _say('  在同一局域网内用手机或另一台电脑的浏览器打开上面的遥控地址即可操作。')
    else:
        _say('  未取到遥控地址：遥控开关可能关着，或副服务没起来，详见 desktop_backend.log。')
    _say('按 Ctrl+C 停止。')

    stop = threading.Event()

    def _on_signal(signum, frame):
        stop.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, _on_signal)
        except (ValueError, OSError, AttributeError):
            pass
    try:
        while not stop.is_set():
            stop.wait(0.5)
    except KeyboardInterrupt:
        pass
    _say('正在停止 SLATE Teams。')


def main():
    global _instance_lock
    args = parse_args()
    # 0. 单实例闸门：必须排在清日志与起后端之前。晚一步就已经多起一份服务、
    #    多一个写同一座 SQLite 的进程，还会把主实例正在写的 desktop_backend.log 清空。
    _instance_lock = desktop_instance.try_acquire(BASE_DIR)
    if _instance_lock is None:
        # 第一份可能正在开窗口（那一刻窗口还不存在），也可能正藏在通知区域里；
        # 两种都要给用户一句回话，不许双击完像什么都没发生。
        surfaced = desktop_instance.handoff(WINDOW_TITLE, BASE_DIR)
        print('SLATE Teams 已在运行：' + ('已切回已有窗口。' if surfaced else '已交给正在启动的那个实例。'))
        return

    # --remote 要赶在起后端之前把强制开关塞进环境变量：源码态后端是子进程，
    # 环境在 Popen 那一刻就被继承定了。
    if args.remote:
        from backend.routers.lan import FORCE_ENV
        os.environ[FORCE_ENV] = '1'

    # 1. 启动 uvicorn 服务器
    open(LOG_PATH, 'w', encoding='utf-8').close()
    os.makedirs(STORAGE_PATH, exist_ok=True)
    print("正在启动后端服务器...")
    # 端口与上游 SLATE 刻意错开：两者是同机共存的两个产品，撞端口只会让先起的那个
    # 把后起的挤到随机端口上，而前端与遥控地址都按这个默认值写。
    preferred_port = 8130
    preferred_url = f'http://127.0.0.1:{preferred_port}'
    uvicorn_process = None
    frozen = FROZEN

    # --remote 不复用别人的后端：强制开遥控那个环境变量只对自己起的后端生效，
    # 复用了就保证不了"这次一定有遥控"——而远程模式下用户手上没有界面可以补救。
    # 端口被占时下面会退到回退端口，照样起自己那份。
    if not frozen and not args.remote and can_reuse_server(preferred_url):
        port = preferred_port
        app_url = preferred_url
        log(f'reusing existing backend: {app_url}')
    elif is_port_free(preferred_port):
        port = preferred_port
        app_url = preferred_url
    else:
        port = get_free_port()
        app_url = f'http://127.0.0.1:{port}'
        log(f'port {preferred_port} is busy; using fallback port {port}')

    log(f'app url: {app_url}')
    if uvicorn_process is None and not can_reuse_server(app_url):
        uvicorn_process = start_embedded_uvicorn(port) if frozen else start_uvicorn(port)
        atexit.register(stop_process, uvicorn_process)
        ready, error = wait_for_server(uvicorn_process, app_url)
        if not ready:
            log(f'backend failed: {error}')
            stop_process(uvicorn_process)
            if args.remote:
                # 无界面模式下没有窗口可以承载失败页，把原因交给终端或日志
                _say(f'后端启动失败：{error}（详见 desktop_backend.log）')
                return
            webview.create_window(
                title=WINDOW_TITLE,
                html=f'<h2>SLATE Teams backend failed to start</h2><p>{html_escape(str(error))}</p><p>See desktop_backend.log.</p>',
                width=720,
                height=360,
            )
            webview.start(debug=False)
            return

    # 2. 无界面模式（--remote）：不起窗口、不起托盘，把遥控地址交给终端
    if args.remote:
        try:
            run_remote(app_url)
        finally:
            stop_process(uvicorn_process)
        return

    # 3. 创建 pywebview 窗口，加载本地地址
    log('creating window')
    window = webview.create_window(
        title=WINDOW_TITLE,
        url=app_url,
        width=1200,
        height=800,
        resizable=True,
        confirm_close=False
    )

    # 4. 托盘：关掉窗口不停机，缩到系统通知区域继续跑（先只做 Windows）
    tray_handle = attach_tray(window, log)

    # 5. 启动 pywebview 事件循环（阻塞）
    log('starting webview')
    webview.start(
        debug=False,
        gui=desktop_platform.webview_gui(sys.platform),
        private_mode=False,
        storage_path=STORAGE_PATH,
    )
    log('webview closed')

    # 6. 退出收尾：先摘掉托盘图标（别在通知区域留个按不动的死图标），再确保子进程终止
    tray_handle.shutdown()
    stop_process(uvicorn_process)

if __name__ == '__main__':
    main()
