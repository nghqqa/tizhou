# OCR Benchmark 基线（阶段2）

固定样本：`benchmark-pages.json`（95 页，seed=20260906，分层抽样）。
本文件记录**自动化指标基线**与**待人工标注清单**；所有数值可用
`tools/experimental/eval_metrics.py` 重算复现。

## 指标口径

自动化（无需人工标注）：

| 指标 | 口径 | 局限 |
| --- | --- | --- |
| `silentDropSuspects` | OCR 输出题号单调序列断档数 | 跨段重新起号、OCR 误号都计入，是**嫌疑数**不是真实丢题数 |
| `optionCompleteProxy` | 每页检出 A-D 选项标记数 ÷ (检出题数×4)，再对页取均值 | 跨行/分栏选项会低估 |
| `tableStructProxy` | 表格区/网格检出数与行列一致性 | 无边框表会漏检 |
| `graphicBindProxy` | 图推页 4 图一行或 2x2 网格绑定成功占比 | 版面合并条带无法拆绑（见报告） |
| `ziliaoStructProxy` | 资料分析页表格网格/图表/题干/数字异常计数 | 结构代理，不代表数字正确率 |
| `digitConsistencyVsA` | 与方案A逐页数字 token 集合 Jaccard 均值 | 双引擎一致≠正确 |
| `medianMsPerPage` / `peakRssMb` | 单页耗时中位数 / 进程峰值工作集 | 本机 Windows CPU（DirectML/无 GPU） |

必须人工标注后才能算（`annotation-template.csv` 为模板，`pendingHumanMetrics`）：
**题干完整率、选项完整率(真实)、数字准确率、表格单元格准确率、
图片选项绑定率(真实)、答案配对率(真实)、静默丢题数(真实)**。

## 基线结果（2026-09 测量，Windows CPU）

| 运行 | 引擎 | 页数 | 耗时中位 | 峰值内存 | 静默丢题嫌疑 | 选项齐备代理 |
| --- | --- | --- | --- | --- | --- | --- |
| `engineA-200dpi` | 方案A：RapidOCR 3.9.2（PP-OCRv6 det/rec small ONNX）200DPI（生产现状） | 95 | 805ms | 1615MB | **76** | 0.445 |
| `engineA-structured` | 方案A结构化：RapidDoc 0.9.10（资料分析+图推39页） | 39 | 1.9s | 1670MB | -（无行级输出） | - |
| `expworker-300dpi` | 实验 worker：300DPI+预处理+版面分区+RapidOCR | 95 | 1.2s | 1669MB | 78 | 0.474 |
| `engineC-mineru` | 方案C：MinerU 3.4.5 pipeline CPU（每类型前4页） | 16 | 45.6s | 未测 | - | - |
| `engineB-ziliao` | 方案B：PP-StructureV3（paddleocr 3.7.0 + paddlepaddle 3.0.0 CPU，资料分析20页） | 20 | **124.7s** | **6681MB** | - | - |

结构代理：

| 运行 | 表格 | 图片/图表区 | 图推绑定 | 资料分析结构化 |
| --- | --- | --- | --- | --- |
| A-structured | 11 表格区 | 232 图片区 | - | - |
| expworker | 13（修复图表网格误判后；资料分析5/20页真实表格网格） | 90 | **0/19 绑定，19/19 人工审核** | 5 表格、39 图表、14 题干、2 数字异常 |
| B-ziliao(20页) | **0**（图表被裁为图片，不进正文——无表格魔法） | 图表裁剪图若干 | - | 题干/选项阅读序干净 |
| C-mineru(16页) | 3 HTML 表 | 32 裁剪图 | - | - |

双引擎数字交叉一致性：expworker vs A `meanJaccard = 0.933`（94页）；
B vs A `0.524`（20页，图表页数字被裁走，差异大）；MinerU vs A `0.610`（16页）。

## 解析配对实验（阶段7，真实成对册子）

| 配对案例 | 题本 | 解析/答案册 | 结果 |
| --- | --- | --- | --- |
| 数量关系600题(1-8) | 16页→79条 | 花生十三解析册前20页→23条 | **22 配对**，1 条解析在窗口外；0 错配 |
| 四海判断推理(前20页) | 20页→39条 | 6页答案册→734条答案格 | **7 配对**（题号读对的题 7/7 全对）；OCR 误号题(11→1 等)32 条全部进入「配对待确认」，**0 错配** |

配对原则验证：套/段标题映射（「类比刷题1」双侧对照）+ 题号 + 版面顺序 + LCS 相似度；
答案字母只来自解析册；题干从未被答案反向修正；低置信度一律「配对待确认」。

## 资源与体积台账（阶段3/8 实测）

| 项 | 数值 |
| --- | --- |
| 方案A 模型（生产 venv 内） | 31MB（PP-OCRv6 det/rec small + cls mobile，ONNX） |
| 方案B 环境 | venv 1.1GB + paddlex 模型 1.8GB ≈ **2.9GB**；峰值内存 6.7GB |
| 方案C 环境 | venv 1.3GB + 模型 5.7GB ≈ **7GB**（torch CPU） |
| 实验 worker（300DPI 全管线） | ≈0.9-1.2s/页，峰值 ~940MB |
| 安装坑位记录 | paddle 3.3.1 PIR 与 paddlex 预导出模型不兼容 → 须降级 paddlepaddle 3.0.0 + `paddlex[ocr]` extras；MinerU 需 py≥3.10 独立环境，模型经 modelscope 下载 |

## 回归测试（阶段8）

`tools/experimental/tests/test_regression.py`（14 个用例，真实样本）：
行数守恒、题号零丢失、选项标记零丢失、数字流不进正文、
图推不猜标签不转纯文本、配对待确认门、单页资源台账（300DPI 全管线 ≈0.9-1.1s，峰值 ~945MB）。
样本不在本机时自动跳过。运行：`<应用venv python> tools/experimental/tests/test_regression.py`。

## 待人工标注（下一步）

1. 按 `annotation-template.csv` 补齐 95 页的 `expected_qnos` / `numbers_to_verify` 等列；
2. 人工裁决 `silentDropSuspects`（断档是否为真实丢题）；
3. 产出真实题干完整率/数字准确率/表格单元格准确率后回填本文件。
