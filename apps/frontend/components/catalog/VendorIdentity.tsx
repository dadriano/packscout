import Image from "next/image";
import styles from "./VendorIdentity.module.css";

// Official site icons. Asset provenance: docs/frontend-vendor-logos.md.
const VENDOR_LOGOS: Readonly<Record<string, string>> = {
  phygitals: "/vendor-logos/phygitals.jpg",
  collector_crypt: "/vendor-logos/collector-crypt.svg",
  clutchpacks: "/vendor-logos/clutchpacks.png",
};

export function VendorLogo({ vendorKey }: Readonly<{ vendorKey: string }>) {
  const src = Object.hasOwn(VENDOR_LOGOS, vendorKey) ? VENDOR_LOGOS[vendorKey] : null;
  if (!src) return null;
  return <Image alt="" className={styles.logo} height={20} src={src} unoptimized width={20} />;
}

export function VendorIdentity({
  vendorKey,
  name,
}: Readonly<{ vendorKey: string; name: string }>) {
  return (
    <span className={styles.identity}>
      <VendorLogo vendorKey={vendorKey} />
      <span className={styles.name}>{name}</span>
    </span>
  );
}
