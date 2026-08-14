"use client";

import Image from "next/image";
import { useState } from "react";
import type { PublicImage } from "@packscout/contracts";
import styles from "./CatalogImage.module.css";

type CatalogImageProps = Readonly<{
  image: PublicImage | null;
  fallbackAlt: string;
  variant: "thumbnail" | "pack" | "chase" | "vendor";
  fallback?: "pack" | "none";
  decorative?: boolean;
}>;

const IMAGE_DIMENSIONS = Object.freeze({
  thumbnail: { width: 48, height: 64 },
  pack: { width: 160, height: 220 },
  chase: { width: 92, height: 124 },
  vendor: { width: 24, height: 24 },
});

export function CatalogImage({
  image,
  fallbackAlt,
  variant,
  fallback = "pack",
  decorative = false,
}: CatalogImageProps) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const dimensions = IMAGE_DIMENSIONS[variant];
  const canRenderImage = image !== null && image.url !== failedUrl;

  if (canRenderImage) {
    return (
      <span className={styles.frame} data-variant={variant}>
        <Image
          alt={decorative ? "" : image.alt || fallbackAlt}
          className={styles.image}
          height={dimensions.height}
          loading={variant === "pack" ? "eager" : "lazy"}
          onError={() => setFailedUrl(image.url)}
          src={image.url}
          unoptimized
          width={dimensions.width}
        />
      </span>
    );
  }

  if (fallback === "none") return null;

  return (
    <span
      aria-label={`${fallbackAlt} image unavailable`}
      className={styles.frame}
      data-variant={variant}
      role="img"
    >
      <span aria-hidden="true" className={styles.placeholderMark}>
        P
      </span>
    </span>
  );
}
