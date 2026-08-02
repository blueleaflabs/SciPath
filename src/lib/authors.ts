import { getCollection } from 'astro:content';
import type { CollectionEntry } from 'astro:content';

export interface AuthorPage {
  slug: string;
  displayName: string;
  school?: string;
  gradYear?: number;
  affiliationVerified: boolean;
  articles: CollectionEntry<'articles'>[];
}

/**
 * Author pages are built from the bylines on published records, because a
 * byline is a historical fact stored on the record rather than a join.
 *
 * A co-author outside the organization carries authorSlug null: plain text,
 * no page. They never consented to one and have no way to control it.
 */
export async function getAuthorPages(): Promise<AuthorPage[]> {
  const articles = (await getCollection('articles')).filter(
    (a) => a.data.status !== 'archived'
  );

  const pages = new Map<string, AuthorPage>();

  for (const article of articles) {
    for (const author of article.data.authors) {
      if (!author.authorSlug) continue;
      const existing = pages.get(author.authorSlug);
      if (existing) {
        existing.articles.push(article);
        existing.affiliationVerified ||= author.affiliationVerified;
      } else {
        pages.set(author.authorSlug, {
          slug: author.authorSlug,
          displayName: author.displayName,
          school: author.school,
          gradYear: author.gradYear,
          affiliationVerified: author.affiliationVerified,
          articles: [article],
        });
      }
    }
  }

  for (const page of pages.values()) {
    page.articles.sort((a, b) => b.data.publishedOn.valueOf() - a.data.publishedOn.valueOf());
  }

  return [...pages.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** Typographic fallback for a portrait that is opt-in and usually absent. */
export function monogram(displayName: string): string {
  return displayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}
