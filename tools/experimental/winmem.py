# -*- coding: utf-8 -*-
"""Windows 进程峰值内存测量（无第三方依赖）。"""
from __future__ import annotations

import ctypes


def peak_rss_mb() -> float:
    """当前进程峰值工作集（MB）。非 Windows 或失败返回 -1。"""
    try:
        kernel32 = ctypes.windll.kernel32
        psapi = ctypes.windll.psapi
        kernel32.GetCurrentProcess.restype = ctypes.c_void_p

        class PMC(ctypes.Structure):
            _fields_ = [('cb', ctypes.c_ulong), ('PageFaultCount', ctypes.c_ulong),
                        ('PeakWorkingSetSize', ctypes.c_size_t),
                        ('WorkingSetSize', ctypes.c_size_t),
                        ('QuotaPeakPagedPoolUsage', ctypes.c_size_t),
                        ('QuotaPagedPoolUsage', ctypes.c_size_t),
                        ('QuotaPeakNonPagedPoolUsage', ctypes.c_size_t),
                        ('QuotaNonPagedPoolUsage', ctypes.c_size_t),
                        ('PagefileUsage', ctypes.c_size_t),
                        ('PeakPagefileUsage', ctypes.c_size_t)]

        pmc = PMC()
        pmc.cb = ctypes.sizeof(PMC)
        handle = kernel32.GetCurrentProcess()
        if not psapi.GetProcessMemoryInfo(ctypes.c_void_p(handle), ctypes.byref(pmc), pmc.cb):
            return -1.0
        return round(pmc.PeakWorkingSetSize / (1024 * 1024), 1)
    except Exception:
        return -1.0
