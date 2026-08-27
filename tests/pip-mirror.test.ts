import { describe, expect, it } from 'vitest'
import {
  normalizeMirrorPreference,
  pickMirrorByProbes,
  type MirrorProbeResult
} from '../src/main/services/pip-mirror'
import { PIP_MIRROR_OPTIONS, PIP_MIRRORS, pipMirrorLabel } from '../src/shared/pip-mirrors'

describe('pip mirror', () => {
  it('keeps shared mirror list sane (unique ids, https endpoints)', () => {
    const ids = PIP_MIRRORS.map((mirror) => mirror.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const mirror of PIP_MIRRORS) expect(mirror.indexUrl.startsWith('https://')).toBe(true)
    expect(PIP_MIRROR_OPTIONS[0]?.id).toBe('auto')
  })

  it('normalizes unknown or empty preferences back to auto', () => {
    expect(normalizeMirrorPreference(undefined)).toBe('auto')
    expect(normalizeMirrorPreference('nope')).toBe('auto')
    expect(normalizeMirrorPreference('tuna')).toBe('tuna')
    expect(normalizeMirrorPreference('auto')).toBe('auto')
  })

  it('prefers the fastest reachable domestic mirror over pypi', () => {
    const probes: MirrorProbeResult[] = [
      { id: 'pypi', label: '', indexUrl: '', reachable: true, elapsedMs: 50 },
      { id: 'tuna', label: '', indexUrl: '', reachable: true, elapsedMs: 300 },
      { id: 'aliyun', label: '', indexUrl: '', reachable: true, elapsedMs: 120 }
    ]
    expect(pickMirrorByProbes(probes).id).toBe('aliyun')
  })

  it('falls back to pypi when every mirror is unreachable, and skips unreachable domestic ones', () => {
    const all: MirrorProbeResult[] = ['pypi', 'tuna', 'aliyun'].map((id) => ({
      id,
      label: '',
      indexUrl: '',
      reachable: false,
      elapsedMs: 2500
    }))
    expect(pickMirrorByProbes(all).id).toBe('pypi')
    const onlyPypiAlive: MirrorProbeResult[] = [
      { id: 'pypi', label: '', indexUrl: '', reachable: true, elapsedMs: 900 },
      { id: 'tuna', label: '', indexUrl: '', reachable: false, elapsedMs: 0 }
    ]
    expect(pickMirrorByProbes(onlyPypiAlive).id).toBe('pypi')
  })

  it('labels mirror ids for display', () => {
    expect(pipMirrorLabel('tuna')).toBe('清华 TUNA')
    expect(pipMirrorLabel('auto')).toContain('自动')
    expect(pipMirrorLabel('unknown')).toContain('自动')
  })
})
