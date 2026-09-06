# OCR Benchmark —— 脏乱考公题本高精度导入专项

本目录是「脏乱考公题本 PDF 高精度导入」专项调研的**落盘基线**（阶段1-3、8-9 产物）。
实验代码全部在 `tools/experimental/`，不接入生产链路，不改动现有 RapidOCR 通道。

## 数据来源（真实样本）

- 样本目录：`E:/BaiduNetdiskDownload/考公刷题本答案`（可用环境变量 `TIZHU_SAMPLE_DIR` 覆盖）
- 42 个真实考公题本 PDF，共 5103 页
- **98.3% 的页面没有有效文字层**（文字层字符 < 50，与生产 `tools/ocr-worker.py` 判定一致）
- 页面形态：中文正文、表格、柱状/统计图、页眉、水印、解析、图形推理

## 文件说明

| 文件                              | 生成者               | 说明                                               |
| --------------------------------- | -------------------- | -------------------------------------------------- |
| `inventory.json` / `inventory.md` | `survey_pdfs.py`     | 阶段1：逐 PDF 页数/文字层/扫描页比例/图片对象/分类 |
| `page-stats.json`                 | `benchmark_build.py` | 逐页文字层字符与图片对象信号（审计用）             |
| `benchmark-pages.json`            | `benchmark_build.py` | 阶段2：固定种子抽取的 95 页基准页面清单            |
| `annotation-template.csv`         | `benchmark_build.py` | 人工标注模板（已自动填写可自动获得的列）           |
| `metrics-*.json`                  | `eval_metrics.py`    | 各引擎在 95 页基准上的自动化指标                   |
| `baseline.md`                     | 人工                 | 阶段2基线：指标口径、自动化结果、待人工标注清单    |
| `research-report.md`              | 人工                 | 阶段9：调研报告（瓶颈/对比/推荐）                  |

## 确定性与工作区清洁

- 抽样只依赖 `inventory.json` 内容 + 固定种子 `20260906`，**不含时间戳**，重跑不产生 diff。
- 渲染图、裁剪图、OCR 原始输出等**易变产物**全部写在仓库外
  `E:/tizhou-ocr-bank/exp/`（环境变量 `TIZHU_EXP_DIR`），不会弄脏工作区。

## 复现命令

```bash
PY=<应用venv>/Scripts/python.exe   # 含 rapidocr 3.9.2 / rapid-doc 0.9.10 / pypdfium2 / opencv
$PY tools/experimental/survey_pdfs.py                       # 阶段1
$PY tools/experimental/benchmark_build.py                   # 阶段2
$PY tools/experimental/run_engine.py A engineA-200dpi       # 阶段3-方案A（生产现状 200DPI）
$PY tools/experimental/run_engine.py A-structured engineA-structured
$PY tools/experimental/run_engine_b.py engineB-ppstruct ... # 方案B（venv-b：paddleocr 3.7 CPU）
$PY tools/experimental/run_engine_c.py engineC-mineru ...   # 方案C（venv-mineru）
$PY tools/experimental/exp_worker.py run-benchmark expworker-300dpi   # 阶段4-6 实验worker
$PY tools/experimental/eval_metrics.py <run> "<label>" [--vs engineA-200dpi]
$PY tools/experimental/tests/test_regression.py             # 阶段8 真实样本回归测试
```

## 指标口径

自动化指标（无需人工标注，可重复计算）：

- `silentDropSuspects`：OCR 输出中题号单调序列的断档数（**嫌疑数**——跨章重新起号也会计入，最终以人工标注裁决）；
- `optionCompleteProxy`：检出题目中 A-D 选项标记齐备程度的页面均值；
- `digitConsistencyVsA`：与方案A逐页数字 token 集合的 Jaccard 一致性（双引擎交叉代理）；
- `tableStructProxy` / `graphicBindProxy` / `ziliaoStructProxy`：表格网格、图推绑定、资料分析结构化产出计数。

人工标注后才能计算的指标（`annotation-template.csv` 提供模板）：

题干完整率、选项完整率（真实）、数字准确率、表格单元格准确率、
图片选项绑定率（真实）、答案配对率（真实）、静默丢题数（真实）。

**本轮不做任何「资料分析/图形推理已达自动高准确率」的声称**；
只有真实样本指标改善且静默丢题为 0 之后，才允许讨论替换生产通道。
