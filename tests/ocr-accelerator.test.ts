import { describe, expect, it } from 'vitest'
import { pickGpuAdapter, setRapidocrDmlEnabled } from '../src/main/services/ocr-accelerator'

describe('gpu accelerator helpers', () => {
  it('picks the first discrete adapter and ignores virtual display devices', () => {
    expect(
      pickGpuAdapter([
        'OrayIddDriver Device',
        'GameViewer Virtual Display Adapter',
        'NVIDIA GeForce RTX 3090'
      ])
    ).toBe('NVIDIA GeForce RTX 3090')
    expect(pickGpuAdapter(['Intel(R) UHD Graphics 620', 'NVIDIA GeForce MX450'])).toBe(
      'NVIDIA GeForce MX450'
    )
  })

  it('returns undefined for machines without an accelerator-worthy adapter', () => {
    expect(pickGpuAdapter(['Intel(R) UHD Graphics 620'])).toBeUndefined()
    expect(
      pickGpuAdapter(['Microsoft Basic Render Driver', 'OrayIddDriver Device'])
    ).toBeUndefined()
    expect(pickGpuAdapter([])).toBeUndefined()
  })

  it('recognises AMD and Intel Arc discrete cards', () => {
    expect(pickGpuAdapter(['AMD Radeon RX 7600'])).toBe('AMD Radeon RX 7600')
    expect(pickGpuAdapter(['Intel Arc A750'])).toBe('Intel Arc A750')
  })

  it('flips use_dml on for the first occurrence and off everywhere', () => {
    const config = [
      'onnxruntime:',
      '  use_cuda: false',
      '    use_dml: false',
      '  dml_ep_cfg: null',
      'paddle:',
      '  use_dml: false'
    ].join('\n')
    const enabled = setRapidocrDmlEnabled(config, true)
    expect(enabled.match(/use_dml: true/g)).toHaveLength(1)
    expect(enabled).toContain('    use_dml: true')

    const disabled = setRapidocrDmlEnabled(enabled, false)
    expect(disabled.match(/use_dml: true/g)).toBeNull()
    expect(disabled.match(/use_dml: false/g)).toHaveLength(2)
  })

  it('is a no-op when the switch is already in the requested state', () => {
    const config = 'use_dml: true'
    expect(setRapidocrDmlEnabled(config, true)).toBe(config)
    expect(setRapidocrDmlEnabled('use_dml: false', false)).toBe('use_dml: false')
  })
})
