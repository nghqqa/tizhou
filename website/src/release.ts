// 官网发布配置（单一来源）：版本、下载通道、自建直链开关、站点 URL、页脚信息位。
// 修改版本号时只改这里；站点域名更换时同步改 url 字段，sitemap 与 OG 标签在构建时自动跟随。
export const release = {
  version: '1.0.38',
  platform: 'Windows 10/11 64 位',
  license: 'MIT 开源',
  siteUrl: 'https://tizhou.nghqqa.cn',
  asset: {
    name: 'tizhou-setup-1.0.38.exe',
    sizeHint: '约 129 MB',
    checksumFile: 'SHA256SUMS.txt',
    checksumCommand: 'certutil -hashfile tizhou-setup-1.0.38.exe SHA256'
  },
  // 主按钮直连匿名下载（CNB Releases 附件，已验证匿名 200）；
  // releasePages 作为「全量文件与校验文件」入口，安装包流量不经过自有 Web 服务器
  directDownload: {
    url: 'https://cnb.cool/nghqqa/tizhou/-/releases/download/v1.0.38/tizhou-setup-1.0.38.exe'
  },
  checksumUrls: {
    cnb: 'https://cnb.cool/nghqqa/tizhou/-/releases/download/v1.0.38/SHA256SUMS.txt',
    github: 'https://github.com/nghqqa/tizhou/releases/download/v1.0.38/SHA256SUMS.txt'
  },
  releasePages: {
    cnb: 'https://cnb.cool/nghqqa/tizhou/-/releases',
    github: 'https://github.com/nghqqa/tizhou/releases/latest'
  },
  channels: [
    {
      id: 'github',
      label: 'GitHub Releases',
      provider: 'GitHub',
      url: 'https://github.com/nghqqa/tizhou/releases/latest',
      primary: false,
      note: '国际网络适用'
    }
  ],
  selfHosted: {
    enabled: false,
    url: '/downloads/tizhou-setup-1.0.38.exe',
    note: '服务器直链（带宽充足后改 enabled 为 true 即可启用）'
  },
  icp: ''
}
