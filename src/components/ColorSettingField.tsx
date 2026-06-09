import { normalizeColor } from '../settings';

export function ColorSettingField({ label, value, fallback, onChange }: {
  label: string;
  value: string;
  fallback: string;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      {label}
      <div className="colorField">
        <input
          type="color"
          value={normalizeColor(value, fallback)}
          onChange={(e) => onChange(e.target.value)}
        />
        <input
          value={value}
          placeholder={fallback}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    </label>
  );
}
