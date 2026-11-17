// 官网发布配置（单一来源）：版本、下载通道、自建直链开关、站点 URL、页脚信息位。
// 修改版本号时只改这里；站点域名更换时同步改 url 字段，sitemap 与 OG 标签在构建时自动跟随。
export const release = {
  version: '1.0.15',
  platform: 'Windows 10/11 64 位',
  license: 'MIT 开源',
  siteUrl: 'https://tizhou.nghqqa.cn',
  asset: {
    name: 'tizhou-setup-1.0.15.exe',
    sizeHint: '约 130 MB',
    checksumFile: 'SHA256SUMS.txt',
    checksumHint:
      '下载页同目录提供 SHA256SUMS.txt，可用 certutil -hashfile tizhou-setup-1.0.15.exe SHA256 对照校验'
  },
  channels: [
    {
      id: 'cnb',
      label: '国内高速下载',
      provider: 'CNB Releases',
      url: 'https://cnb.cool/nghqqa/tizhou/-/releases',
      primary: true,
      note: '国内访问快，推荐'
    },
    {
      id: 'github',
      label: 'GitHub Releases',
      provider: 'GitHub',
      url: 'https://github.com/nghqqa/tizhou/releases/latest',
      primary: false,
      note: '无国际网络问题也可用'
    }
  ],
  selfHosted: {
    enabled: false,
    url: '/downloads/tizhou-setup-1.0.15.exe',
    note: '服务器直链（带宽充足后改 enabled 为 true 即可启用）'
  },
  icp: ''
}
