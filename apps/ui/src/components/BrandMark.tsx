import { assetUrl } from "../lib/assetUrl";

type BrandMarkProps = {
  subtitle?: string;
  compact?: boolean;
  iconOnly?: boolean;
};

export function BrandMark({ subtitle = "Vessel OS", compact = false, iconOnly = false }: BrandMarkProps) {
  return (
    <div className={compact ? "brand-mark brand-mark--compact" : "brand-mark"}>
      <img className="brand-mark__image" src={assetUrl("/brand/logo.png")} alt="Palmer Lou artwork" />
      {iconOnly ? null : (
        <div className="brand-mark__copy">
          <span className="brand-mark__title">Palmer Lou</span>
          {compact ? null : <span className="brand-mark__subtitle">{subtitle}</span>}
        </div>
      )}
    </div>
  );
}
