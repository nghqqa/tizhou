import { BAIGUAFEN_TABLE, FORMULA_HINTS } from './constants'

export function FormulaCheatCard(): React.JSX.Element {
  return (
    <div className="formula-cheat-card">
      <div className="formula-cheat-col">
        <strong>常用百化分速查</strong>
        <div className="baiguafen-grid">
          {BAIGUAFEN_TABLE.map(([frac, pct]) => (
            <span key={frac} className="baiguafen-chip">
              <b>{frac}</b> = {pct}
            </span>
          ))}
        </div>
      </div>
      <div className="formula-cheat-col">
        <strong>资料分析高频公式</strong>
        <ul className="formula-list">
          {FORMULA_HINTS.map((item) => (
            <li key={item.name}>
              <b>{item.name}：</b>
              <span>{item.expr}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
