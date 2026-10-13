export default function BrandLogo() {
  return (
    <span className="brand-logo" aria-hidden="true">
      {/* In-page identity is monochrome; colored files remain favicon/app-icon assets. */}
      <img className="brand-logo-light" src="/brand/logo-black.svg" alt="" width={32} height={32} />
      <img className="brand-logo-dark" src="/brand/logo-white.svg" alt="" width={32} height={32} />
    </span>
  );
}
