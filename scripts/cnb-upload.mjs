// cnb.cool Release 管理与附件上传模块：
// 1. 支持被 scripts/release.mjs 模块化调用（安全读取令牌、幂等创建/更新 Release、三步上传附件）；
// 2. 保留原 CLI 兼容：node scripts/cnb-upload.mjs <token> <release_id> <file1> [file2...]
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const CNB_REPO = 'nghqqa/tizhou'
export const CNB_API_ORIGIN = 'https://api.cnb.cool'

export function redactSecret(text, secret) {
  const raw = String(text ?? '')
  if (!secret || typeof secret !== 'string' || secret.length === 0) return raw
  return raw.split(secret).join('[REDACTED]')
}

export function parseGitCredentialOutput(stdout) {
  for (const rawLine of String(stdout ?? '').split(/\r?\n/)) {
    const idx = rawLine.indexOf('=')
    if (idx <= 0) continue
    const key = rawLine.slice(0, idx).trim()
    const value = rawLine.slice(idx + 1).trim()
    if (key === 'password' && value.length > 0) {
      return value
    }
  }
  return ''
}

export function resolveCnbToken({ env = process.env, execCredentialFill } = {}) {
  const fromEnv = typeof env?.CNB_TOKEN === 'string' ? env.CNB_TOKEN.trim() : ''
  if (fromEnv) return fromEnv

  const runFill =
    execCredentialFill ??
    (() => {
      const res = spawnSync('git', ['credential', 'fill'], {
        input: 'protocol=https\nhost=cnb.cool\n\n',
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10_000
      })
      if (res.status !== 0) return ''
      return res.stdout ?? ''
    })

  const credentialOut = runFill()
  const fromCred = parseGitCredentialOutput(credentialOut)
  if (fromCred) return fromCred

  throw new Error(
    '未获取到 CNB 访问令牌：请设置环境变量 CNB_TOKEN，或在系统 Git Credential Helper 中配置 https://cnb.cool 凭据'
  )
}

async function readSafeSnippet(response, token) {
  try {
    const text = await response.text()
    return redactSecret(text, token).slice(0, 240)
  } catch {
    return ''
  }
}

export async function ensureCnbRelease({
  token,
  version,
  title,
  notes,
  repo = CNB_REPO,
  apiOrigin = CNB_API_ORIGIN,
  fetchImpl = fetch
}) {
  if (!token || typeof token !== 'string' || !token.trim()) {
    throw new Error('缺少 CNB 访问令牌')
  }
  const cleanToken = token.trim()
  const tagName = String(version).startsWith('v') ? String(version) : `v${version}`
  const authHeaders = {
    Authorization: `Bearer ${cleanToken}`,
    Accept: 'application/json'
  }

  const queryUrl = `${apiOrigin}/${repo}/-/releases/tags/${encodeURIComponent(tagName)}`
  const getRes = await fetchImpl(queryUrl, { method: 'GET', headers: authHeaders })

  if (getRes.status === 200) {
    const existing = await getRes.json()
    const id = String(existing?.id ?? '').trim()
    if (!id) {
      throw new Error(`CNB Release ${tagName} 查询成功但缺少 id 字段`)
    }
    const patchUrl = `${apiOrigin}/${repo}/-/releases/${encodeURIComponent(id)}`
    const patchRes = await fetchImpl(patchUrl, {
      method: 'PATCH',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: title,
        body: notes,
        draft: false,
        prerelease: false,
        make_latest: 'true'
      })
    })
    if (!patchRes.ok) {
      const detail = await readSafeSnippet(patchRes, cleanToken)
      throw new Error(`CNB Release ${tagName} 更新失败 (${patchRes.status}): ${detail}`)
    }
    return { id, tagName, created: false }
  }

  if (getRes.status !== 404) {
    const detail = await readSafeSnippet(getRes, cleanToken)
    throw new Error(`CNB Release ${tagName} 查询失败 (${getRes.status}): ${detail}`)
  }

  const createUrl = `${apiOrigin}/${repo}/-/releases`
  const createRes = await fetchImpl(createUrl, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag_name: tagName,
      name: title,
      body: notes,
      draft: false,
      prerelease: false,
      make_latest: 'true'
    })
  })
  if (!createRes.ok) {
    const detail = await readSafeSnippet(createRes, cleanToken)
    throw new Error(`CNB Release ${tagName} 创建失败 (${createRes.status}): ${detail}`)
  }
  const created = await createRes.json()
  const id = String(created?.id ?? '').trim()
  if (!id) {
    throw new Error(`CNB Release ${tagName} 创建响应缺少 id 字段`)
  }
  return { id, tagName, created: true }
}

export async function uploadCnbAsset({
  token,
  releaseId,
  filePath,
  assetName,
  repo = CNB_REPO,
  apiOrigin = CNB_API_ORIGIN,
  fetchImpl = fetch,
  logger = console
}) {
  if (!token || typeof token !== 'string' || !token.trim()) {
    throw new Error('缺少 CNB 访问令牌')
  }
  if (!releaseId || typeof releaseId !== 'string' || !releaseId.trim()) {
    throw new Error('缺少 CNB release_id')
  }
  const cleanToken = token.trim()
  const resolvedPath = path.resolve(filePath)
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`待上传文件不存在：${resolvedPath}`)
  }
  const size = fs.statSync(resolvedPath).size
  if (size <= 0) {
    throw new Error(`待上传文件为空（0 字节）：${resolvedPath}`)
  }
  const name = assetName ?? path.basename(resolvedPath)

  const applyRes = await fetchImpl(
    `${apiOrigin}/${repo}/-/releases/${encodeURIComponent(releaseId.trim())}/asset-upload-url`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cleanToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({ asset_name: name, size, overwrite: true })
    }
  )

  let apply = null
  try {
    apply = await applyRes.json()
  } catch {
    apply = null
  }
  if (!applyRes.ok || !apply?.upload_url || !apply?.verify_url) {
    const detail = redactSecret(JSON.stringify(apply ?? {}), cleanToken).slice(0, 200)
    throw new Error(`申请上传失败 ${applyRes.status}: ${detail}`)
  }

  const data = fs.readFileSync(resolvedPath)
  const putRes = await fetchImpl(apply.upload_url, {
    method: 'PUT',
    body: data,
    headers: { 'Content-Type': 'application/octet-stream' }
  })
  if (!putRes.ok) {
    const detail = await readSafeSnippet(putRes, cleanToken)
    throw new Error(`上传失败 ${putRes.status}: ${detail}`)
  }

  const verifyRes = await fetchImpl(apply.verify_url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cleanToken}`, Accept: 'application/json' }
  })
  if (!verifyRes.ok) {
    const detail = await readSafeSnippet(verifyRes, cleanToken)
    throw new Error(`确认失败 ${verifyRes.status}: ${detail}`)
  }

  logger.log(`OK ${name} (${(size / 1024 / 1024).toFixed(1)} MB)`)
  return { name, size, filePath: resolvedPath }
}

export async function uploadCnbAssets({
  token,
  releaseId,
  files,
  repo = CNB_REPO,
  apiOrigin = CNB_API_ORIGIN,
  fetchImpl = fetch,
  logger = console
}) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('未提供待上传文件列表')
  }
  const results = []
  for (const file of files) {
    results.push(
      await uploadCnbAsset({
        token,
        releaseId,
        filePath: file,
        repo,
        apiOrigin,
        fetchImpl,
        logger
      })
    )
  }
  return results
}

const isDirectRun =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (isDirectRun) {
  const cliToken = process.argv[2]
  const cliReleaseId = process.argv[3]
  const cliFiles = process.argv.slice(4)
  if (!cliToken || !cliReleaseId || cliFiles.length === 0) {
    console.error('用法：node scripts/cnb-upload.mjs <token> <release_id> <file1> [file2...]')
    process.exit(1)
  }
  try {
    await uploadCnbAssets({
      token: cliToken,
      releaseId: cliReleaseId,
      files: cliFiles
    })
    console.log('ALL DONE')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(redactSecret(message, cliToken))
    process.exit(1)
  }
}
