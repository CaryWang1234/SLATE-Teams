"""系统元认知信息：日期时间、硬件配置、电量、网络状态。"""

from __future__ import annotations

import platform
import subprocess
from datetime import datetime

# psutil 可能未安装，延迟导入
try:
    import psutil
    HAS_PSUTIL = True
except ImportError:
    HAS_PSUTIL = False


def _get_cpu_info() -> dict:
    """获取 CPU 信息"""
    freq = psutil.cpu_freq()
    return {
        "cores_physical": psutil.cpu_count(logical=False) or 0,
        "cores_logical": psutil.cpu_count(logical=True) or 0,
        "frequency_mhz": round(freq.current) if freq else None,
        "percent": psutil.cpu_percent(interval=0.1),
    }


def _get_memory_info() -> dict:
    """获取内存信息"""
    mem = psutil.virtual_memory()
    swap = psutil.swap_memory()
    return {
        "total_gb": round(mem.total / (1024**3), 2),
        "available_gb": round(mem.available / (1024**3), 2),
        "percent": mem.percent,
        "swap_total_gb": round(swap.total / (1024**3), 2) if swap.total > 0 else 0,
    }


def _get_storage_info() -> list[dict]:
    """获取磁盘分区信息"""
    partitions = []
    try:
        for part in psutil.disk_partitions(all=False):
            try:
                usage = psutil.disk_usage(part.mountpoint)
                partitions.append({
                    "device": part.device,
                    "mountpoint": part.mountpoint,
                    "fstype": part.fstype,
                    "total_gb": round(usage.total / (1024**3), 2),
                    "used_gb": round(usage.used / (1024**3), 2),
                    "free_gb": round(usage.free / (1024**3), 2),
                    "percent": usage.percent,
                })
            except (PermissionError, OSError):
                continue
    except Exception:
        pass
    return partitions


def _get_gpu_info() -> list[dict]:
    """获取 GPU 信息（Windows + macOS）"""
    gpus = []
    system = platform.system()

    if system == "Windows":
        try:
            result = subprocess.run(
                ["powershell", "-Command",
                 "Get-CimInstance Win32_VideoController | Select-Object Name, AdapterRAM, DriverVersion | ConvertTo-Json"],
                capture_output=True, text=True, timeout=5
            )
            if result.returncode == 0 and result.stdout.strip():
                import json
                data = json.loads(result.stdout)
                if isinstance(data, dict):
                    data = [data]
                for gpu in data:
                    ram_bytes = gpu.get("AdapterRAM")
                    ram_gb = round(ram_bytes / (1024**3), 2) if ram_bytes else None
                    gpus.append({
                        "name": gpu.get("Name", "Unknown"),
                        "vram_gb": ram_gb,
                        "driver_version": gpu.get("DriverVersion"),
                        "type": "integrated" if "integrated" in (gpu.get("Name") or "").lower() else "discrete",
                    })
        except Exception:
            pass

    elif system == "Darwin":  # macOS
        try:
            result = subprocess.run(
                ["system_profiler", "SPDisplaysDataType", "-json"],
                capture_output=True, text=True, timeout=5
            )
            if result.returncode == 0 and result.stdout.strip():
                import json
                data = json.loads(result.stdout)
                items = data.get("SPDisplaysDataType", [])
                for item in items:
                    for gpu in item.get("_items", []):
                        gpus.append({
                            "name": gpu.get("sppci_model", "Unknown"),
                            "vendor": gpu.get("spdisplays_vendor"),
                            "vram_mb": gpu.get("spdisplays_vram_shared") or gpu.get("spdisplays_vram"),
                        })
        except Exception:
            pass

    if not gpus:
        try:
            if hasattr(psutil, 'gpu'):
                for gpu in psutil.gpu():
                    gpus.append({
                        "name": gpu.name,
                        "memory_mb": gpu.memory_total,
                    })
        except Exception:
            pass

    return gpus


def _get_battery_info() -> dict | None:
    """获取电池信息"""
    try:
        battery = psutil.sensors_battery()
        if battery:
            return {
                "percent": battery.percent,
                "power_plugged": battery.power_plugged,
                "secsleft": battery.secsleft if battery.secsleft != psutil.POWER_TIME_UNLIMITED else "unlimited",
            }
    except Exception:
        pass
    return None


def _get_network_info() -> dict:
    """获取网络连接信息"""
    interfaces = {}
    try:
        addrs = psutil.net_if_addrs()
        stats = psutil.net_if_stats()

        for name in addrs:
            iface = {
                "isup": stats[name].isup if name in stats else False,
                "speed_mbps": stats[name].speed if name in stats else 0,
                "addresses": [],
            }
            for addr in addrs[name]:
                if addr.family == 2:  # AF_INET (IPv4)
                    iface["addresses"].append({
                        "type": "ipv4",
                        "address": addr.address,
                        "netmask": addr.netmask,
                    })
                elif addr.family == 23:  # AF_INET6 (IPv6)
                    iface["addresses"].append({
                        "type": "ipv6",
                        "address": addr.address,
                    })
            if iface["addresses"]:
                interfaces[name] = iface
    except Exception:
        pass

    return {
        "interfaces": interfaces,
        "connections_count": len(psutil.net_connections(kind="inet")),
    }


def execute() -> str:
    """获取系统元认知信息并返回格式化文本"""
    if not HAS_PSUTIL:
        return ("psutil 未安装，系统信息这项能力当前不可用"
                "（缺的是 SLATE 运行环境的依赖，需要用户在终端里装）。"
                "请把缺依赖的情况告诉用户，不要自行执行安装命令。")

    now = datetime.now()
    tz = datetime.now().astimezone().tzinfo

    lines = []

    # 日期时间
    lines.append("## 日期时间")
    lines.append(f"- **当前时间**: {now.strftime('%Y-%m-%d %H:%M:%S')}")
    lines.append(f"- **时区**: {tz}")

    # CPU
    cpu = _get_cpu_info()
    lines.append("\n## CPU")
    lines.append(f"- **物理核心**: {cpu['cores_physical']} 核")
    lines.append(f"- **逻辑线程**: {cpu['cores_logical']} 线程")
    if cpu['frequency_mhz']:
        lines.append(f"- **主频**: {cpu['frequency_mhz']} MHz")
    lines.append(f"- **使用率**: {cpu['percent']}%")

    # 内存
    memory = _get_memory_info()
    lines.append("\n## 内存")
    lines.append(f"- **总容量**: {memory['total_gb']} GB")
    lines.append(f"- **可用**: {memory['available_gb']} GB ({100 - memory['percent']}%)")
    if memory['swap_total_gb'] > 0:
        lines.append(f"- **交换空间**: {memory['swap_total_gb']} GB")

    # GPU
    gpus = _get_gpu_info()
    if gpus:
        lines.append("\n## GPU")
        for gpu in gpus:
            type_label = "集成显卡" if gpu.get("type") == "integrated" else "独立显卡"
            vram = f" ({gpu['vram_gb']} GB)" if gpu.get("vram_gb") else ""
            lines.append(f"- **{type_label}**: {gpu['name']}{vram}")

    # 存储
    storage = _get_storage_info()
    if storage:
        lines.append("\n## 存储")
        for disk in storage:
            lines.append(f"- **{disk['mountpoint']}** ({disk['fstype']}): 共 {disk['total_gb']} GB，已用 {disk['used_gb']} GB ({disk['percent']}%)")

    # 电池
    battery = _get_battery_info()
    if battery:
        lines.append("\n## 电池")
        lines.append(f"- **电量**: {battery['percent']}%")
        lines.append(f"- **电源**: {'已连接' if battery['power_plugged'] else '未连接'}")
        if isinstance(battery['secsleft'], (int, float)):
            mins = round(battery['secsleft'] / 60)
            lines.append(f"- **剩余续航**: 约 {mins} 分钟")
        elif battery['secsleft'] == "unlimited":
            lines.append("- **剩余续航**: 无限制（充电中）")

    # 网络
    network = _get_network_info()
    lines.append("\n## 网络")
    lines.append(f"- **活跃连接数**: {network['connections_count']}")
    if network['interfaces']:
        for name, iface in network['interfaces'].items():
            if iface['isup']:
                ipv4 = next((a for a in iface['addresses'] if a['type'] == 'ipv4'), None)
                if ipv4:
                    lines.append(f"- **{name}**: {ipv4['address']} ({iface['speed_mbps']} Mbps)")
    else:
        lines.append("- **接口**: 未检测到活跃网络接口")

    return "\n".join(lines)
