import Image from "next/image";
import {
  providerBannerFor,
  type DashboardProvider,
} from "@/lib/provider-banner";
import styles from "./ProviderBanner.module.css";

export function ProviderBanner({
  provider,
}: Readonly<{ provider: DashboardProvider }>) {
  const banner = providerBannerFor(provider);

  return (
    <div
      className={styles.root}
      data-dashboard-provider-banner={provider}
    >
      <a
        className={styles.link}
        href={banner.destinationHref}
        rel="noopener noreferrer"
        target="_blank"
      >
        <Image
          alt=""
          className={styles.image}
          height={225}
          preload
          sizes="(max-width: 1536px) calc(100vw - 2rem), 1475px"
          src={banner.imageSrc}
          unoptimized
          width={1600}
        />
        <span className="sr-only">
          {banner.linkLabel}. Opens in a new tab.
        </span>
      </a>
    </div>
  );
}
