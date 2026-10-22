export default function BrandLogo() {
  return (
    <span className="brand-logo" aria-hidden="true">
      <img className="brand-logo-light" src="/brand/logo.svg" alt="" width={32} height={32} />
      <img className="brand-logo-dark" src="/brand/logo-dark.svg" alt="" width={32} height={32} />
    </span>
  );
}
