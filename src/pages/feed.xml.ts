import rss from '@astrojs/rss';
import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { org } from '../config/orgs';
import { siteUrl } from '../config/site';

export const GET: APIRoute = async (context) => {
  const articles = (await getCollection('articles'))
    .filter((a) => a.data.status !== 'archived')
    .sort((a, b) => b.data.publishedOn.valueOf() - a.data.publishedOn.valueOf());

  return rss({
    title: org.name,
    description: org.showcaseNote,
    site: context.site ?? siteUrl,
    items: articles.map((a) => ({
      title: a.data.title,
      pubDate: a.data.publishedOn,
      description: a.data.abstract,
      link: `/articles/${a.data.publishedOn.getUTCFullYear()}/${a.data.slug}/`,
      author: a.data.authors.map((x) => x.displayName).join(', '),
    })),
  });
};
