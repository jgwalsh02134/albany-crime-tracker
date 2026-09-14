export type OgMetaInput = {
  title: string;
  description: string;
  imagePath: string;
};

export function ogMetaTags(meta: OgMetaInput, canonicalUrl: string) {
  const image = meta.imagePath.startsWith("http")
    ? meta.imagePath
    : `https://app.albany.watch${meta.imagePath.startsWith("/") ? meta.imagePath : `/${meta.imagePath}`}`;
  return [
    { title: meta.title },
    { name: "description", content: meta.description },
    { property: "og:title", content: meta.title },
    { property: "og:description", content: meta.description },
    { property: "og:type", content: "article" },
    { property: "og:url", content: canonicalUrl },
    { property: "og:image", content: image },
    { property: "og:image:width", content: "1200" },
    { property: "og:image:height", content: "630" },
    { property: "og:site_name", content: "Albany County Crime Tracker" },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: meta.title },
    { name: "twitter:description", content: meta.description },
    { name: "twitter:image", content: image },
  ];
}

