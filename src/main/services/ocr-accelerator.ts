// GPU 加速组件（可选）：DirectML 后端的纯逻辑部分。
// 设计要点（实测依据，RTX 3090 对照实验）：
// - 走 onnxruntime-directml 而非 onnxruntime-gpu：后者按特定 CUDA 版本编译且不捆绑
//   DLL（cu13 轮子 PyPI 上是空占位包），终端机器依赖地狱；DML 走 DX12，N/A/Intel 通吃，
//   无 DX12 时 ORT 自动回退 CPU，识别结果与 CPU 逐字节一致（质量无损）。
// - onnxruntime 与 onnxruntime-directml 是同一个 import 名，互斥共存，切换=卸装互换。

export const DIRECTML_PACKAGE = 'onnxruntime-directml==1.24.4'
// 回退安装沿用 installEngine 的原始规格（不钉死小版本，与首次安装行为一致）
export const CPU_ONNXRUNTIME_SPEC = 'onnxruntime>=1.20'

// 虚拟/无加速价值的显卡适配器（远程工具的虚拟显示、基础渲染等）
const VIRTUAL_ADAPTER =
  /(虚拟|Virtual|IddDriver|Basic Render|Oray|GameViewer|向日葵|ToDesk|DisplayLink)/i
// 有加速价值的独立显卡特征；核显不推荐（收益接近零且有驱动兼容前科）
const DISCRETE_ADAPTER =
  /(NVIDIA|GeForce|Quadro|RTX|GTX|Radeon RX|Intel.*(Arc|A7|A750)|AMD Radeon (RX|PRO))/i

// 从 Win32_VideoController 的名称列表里挑出值得推荐 GPU 加速的适配器；
// 无匹配返回 undefined（调用方据此隐藏安装入口，回退 CPU 推理）。
export function pickGpuAdapter(names: string[]): string | undefined {
  const candidates = names
    .map((name) => name.trim())
    .filter((name) => name && !VIRTUAL_ADAPTER.test(name))
  return candidates.find((name) => DISCRETE_ADAPTER.test(name))
}

// 翻转 rapidocr config.yaml 的 use_dml 开关。
// - 启用：只把第一处 use_dml: false 置 true（onnxruntime 段），其余段不动
// - 停用：所有 use_dml: true 归 false，避免残留段落意外走 GPU
export function setRapidocrDmlEnabled(configText: string, enabled: boolean): string {
  if (enabled) return configText.replace('use_dml: false', 'use_dml: true')
  return configText.replace(/use_dml: true/g, 'use_dml: false')
}
