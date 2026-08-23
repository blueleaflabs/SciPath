export const prerender = false;

import rss from '@astrojs/rss';
import type { APIRoute } from 'astro';
import { originForOrg } from '../../lib/deployment';
import { openArchive } from '../../lib/archive';

export const GET: APIRoute = async (context) => {
  const archive = await openArchive(context);
  const org = archive.org;
  const articles = archive.all;

  return rss({
    title: org.name,
    description: org.showcaseNote,
    site: originForOrg(org),
    items: articles.map((a) => ({
      title: a.title,
      pubDate: new Date(`${a.publishedOn}T00:00:00Z`),
      description: a.abstract,
      link: `/${a.recordKind === 'project' ? 'projects' : 'articles'}/${a.year}/${a.slug}/`,
      author: a.authors.map((x) => x.displayName).join(', '),
    })),
  });
};
