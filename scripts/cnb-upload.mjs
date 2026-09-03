// cnb.cool Release 附件上传：申请 upload_url → PUT 文件流 → verify_url 确认
// 用法：node scripts/cnb-upload.mjs <token> <release_id> <file1> [file2...]
import fs from 'node:fs'

const TOKEN = process.argv[2]
const RELEASE_ID = process.argv[3]
const REPO = 'nghqqa/tizhou'
const FILES = process.argv.slice(4)

async function upload(name, filePath) {
  const size = fs.statSync(filePath).size
  const applyRes = await fetch(
    `https://api.cnb.cool/${REPO}/-/releases/${RELEASE_ID}/asset-upload-url`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({ asset_name: name, size, overwrite: true })
    }
  )
  const apply = await applyRes.json()
  if (!applyRes.ok || !apply.upload_url) {
    throw new Error(`申请上传失败 ${applyRes.status}: ${JSON.stringify(apply).slice(0, 200)}`)
  }
  const data = fs.readFileSync(filePath)
  const putRes = await fetch(apply.upload_url, {
    method: 'PUT',
    body: data,
    headers: { 'Content-Type': 'application/octet-stream' }
  })
  if (!putRes.ok) {
    throw new Error(`上传失败 ${putRes.status}: ${(await putRes.text()).slice(0, 200)}`)
  }
  const verifyRes = await fetch(apply.verify_url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' }
  })
  if (!verifyRes.ok) {
    throw new Error(`确认失败 ${verifyRes.status}: ${(await verifyRes.text()).slice(0, 200)}`)
  }
  console.log(`OK ${name} (${(size / 1024 / 1024).toFixed(1)} MB)`)
}

for (const file of FILES) {
  await upload(file.split('/').pop(), file)
}
console.log('ALL DONE')
