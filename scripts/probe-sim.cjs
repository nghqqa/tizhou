// 复现应用的 structuredParseAvailable 探测：与应用相同的 spawn 方式
const { execFile } = require('child_process')
const path = require('path')

const pythonPath = path.join(
  process.env.APPDATA,
  'tizhou',
  'knowledge-builder',
  'engine',
  '.venv',
  'Scripts',
  'python.exe'
)
console.log('pythonPath:', pythonPath, 'exists:', require('fs').existsSync(pythonPath))

execFile(
  pythonPath,
  ['-c', 'import rapid_doc'],
  {
    timeout: 30000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, PYTHONUTF8: '1' }
  },
  (err, stdout, stderr) => {
    if (err) {
      console.log('PROBE FAIL:', err.message.slice(0, 300))
      if (stderr) console.log('STDERR:', String(stderr).slice(0, 300))
    } else {
      console.log('PROBE OK')
    }
    // 再复现 structuredConvert 的 spawn：worker --structured
    const workerPath = path.join(process.cwd(), 'tools', 'ocr-worker.py')
    console.log('workerPath exists:', require('fs').existsSync(workerPath))
    execFile(
      pythonPath,
      [
        workerPath,
        path.join(
          'E:',
          'BaiduNetdiskDownload',
          '考公刷题本答案',
          '资料分析600题',
          '资料分析600题-题本（16-18）.pdf'
        ),
        path.join(process.env.TEMP || '', 'spawn-sim.md'),
        '--structured'
      ],
      {
        timeout: 300000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, PYTHONUTF8: '1' }
      },
      (err2, stdout2, stderr2) => {
        console.log('WORKER rc:', err2 ? 'FAIL ' + String(err2.message).slice(0, 200) : 'ok')
        if (stderr2) console.log('worker stderr:', String(stderr2).slice(0, 400))
        const fs = require('fs')
        const out = path.join(process.env.TEMP || '', 'spawn-sim.md')
        if (fs.existsSync(out)) {
          const md = fs.readFileSync(out, 'utf8')
          console.log(
            'spawn-sim md:',
            md.length,
            '字符 | 表格:',
            (md.match(/<table>/g) ?? []).length,
            '| 题号行:',
            (md.match(/^\d{1,3}\./gm) ?? []).length
          )
        }
      }
    )
  }
)
