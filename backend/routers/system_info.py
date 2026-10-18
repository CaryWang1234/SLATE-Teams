"""系统元认知信息：日期时间、硬件配置、电量、音量、网络状态。"""

from __future__ import annotations

import platform
import subprocess
from datetime import datetime

from fastapi import APIRouter
from pydantic import BaseModel

# psutil 可能未安装，延迟导入
try:
    import psutil
    HAS_PSUTIL = True
except ImportError:
    HAS_PSUTIL = False

router = APIRouter(prefix="/system", tags=["system"])


class SystemInfoResponse(BaseModel):
    datetime: str
    timezone: str
    cpu: dict
    memory: dict
    storage: list[dict]
    gpus: list[dict]
    battery: dict | None
    network: dict


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
            # PowerShell 查询所有显示适配器
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
                        vram = gpu.get("sppci_bus_type")  # VRAM info varies
                        gpus.append({
                            "name": gpu.get("sppci_model", "Unknown"),
                            "vendor": gpu.get("spdisplays_vendor"),
                            "vram_mb": gpu.get("spdisplays_vram_shared") or gpu.get("spdisplays_vram"),
                        })
        except Exception:
            pass

    # Fallback: 如果没有检测到 GPU，尝试使用 psutil（Linux）
    if not gpus:
        try:
            # 某些版本的 psutil 支持 GPU
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


@router.get("/info")
async def get_system_info():
    """获取系统元认知信息"""
    if not HAS_PSUTIL:
        return {
            "code": 1,
            "message": "psutil 未安装，系统信息当前不可用（需要用户在运行环境里安装该依赖）",
            "data": None
        }
    
    now = datetime.now()
    tz = datetime.now().astimezone().tzinfo

    return {
        "code": 0,
        "data": {
            "datetime": now.strftime("%Y-%m-%d %H:%M:%S"),
            "timezone": str(tz),
            "cpu": _get_cpu_info(),
            "memory": _get_memory_info(),
            "storage": _get_storage_info(),
            "gpus": _get_gpu_info(),
            "battery": _get_battery_info(),
            "network": _get_network_info(),
        },
        "message": "ok"
    }
