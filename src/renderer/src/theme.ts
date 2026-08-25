import {
  createDarkTheme,
  createLightTheme,
  type BrandVariants,
  type Theme
} from '@fluentui/react-components'

const brand: BrandVariants = {
  10: '#170C08',
  20: '#2A130C',
  30: '#441C10',
  40: '#5E2616',
  50: '#78321E',
  60: '#924027',
  70: '#AD4F30',
  80: '#D65F35',
  90: '#E4774F',
  100: '#EC906D',
  110: '#F2A98C',
  120: '#F7C1AB',
  130: '#FAD7C9',
  140: '#FCE8E0',
  150: '#FEF4F0',
  160: '#FFF9F7'
}

export const darkTheme: Theme = {
  ...createDarkTheme(brand),
  // 暖石墨中性色：与铁锈橙品牌同温，避免此前墨绿与暖橙的浑浊撞色
  colorNeutralBackground1: '#141210',
  colorNeutralBackground2: '#1A1715',
  colorNeutralBackground3: '#211D1A',
  colorNeutralBackground4: '#282320',
  colorNeutralBackground5: '#2F2925',
  colorNeutralBackground6: '#38312C',
  colorNeutralStroke1: '#3C3530',
  colorNeutralStroke2: '#2D2723',
  colorNeutralForeground1: '#F4F1EE',
  colorNeutralForeground2: '#D0C9C3',
  colorNeutralForeground3: '#9E958D'
}

export const lightTheme: Theme = {
  ...createLightTheme(brand),
  colorNeutralBackground1: '#FBFAF9',
  colorNeutralBackground2: '#F4F1EF',
  colorNeutralBackground3: '#ECE7E3',
  colorNeutralStroke1: '#D9D2CC',
  colorNeutralForeground1: '#211C18',
  colorNeutralForeground2: '#4B433D',
  colorNeutralForeground3: '#746B63'
}
