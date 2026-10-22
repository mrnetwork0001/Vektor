interface Props {
  symbols: string[];
  selected: string;
  onChange: (symbol: string) => void;
}

export function MarketSelector({ symbols, selected, onChange }: Props) {
  return (
    <select
      value={selected}
      onChange={(e) => onChange(e.target.value)}
      className="market-select"
    >
      {symbols.map((s) => (
        <option key={s} value={s}>
          {s}
        </option>
      ))}
    </select>
  );
}
