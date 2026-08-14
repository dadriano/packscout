import Image from "next/image";
import Link from "next/link";

export function BrandLogo() {
  return (
    <Link className="brand-link" href="/" aria-label="PackScout home">
      <Image
        alt=""
        aria-hidden="true"
        className="brand-logo brand-logo--light"
        height={37}
        priority
        src="/brand/packscout-horizontal-light.png"
        width={160}
      />
      <Image
        alt=""
        aria-hidden="true"
        className="brand-logo brand-logo--dark"
        height={37}
        priority
        src="/brand/packscout-horizontal-dark.png"
        width={160}
      />
    </Link>
  );
}
