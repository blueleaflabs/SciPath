/**
 * Font sets per theme. A theme loads its own faces and nothing else, so
 * adding a theme never slows down the themes already shipping.
 *
 * Adding a theme means one block in tokens.css and one row here.
 */

export type ThemeId = 'entry' | 'proceedings';

export const themeFonts: Record<ThemeId, string> = {
  entry:
    'https://fonts.googleapis.com/css2?family=Literata:ital,opsz,wght@0,7..72,300..600;1,7..72,300..600&family=Schibsted+Grotesk:wght@400..800&family=Spline+Sans+Mono:wght@400;500;600&display=swap',
  proceedings:
    'https://fonts.googleapis.com/css2?family=Courier+Prime:ital,wght@0,400;0,700;1,400&family=Spectral:ital,wght@0,300;0,400;0,500;0,600;0,700;1,400;1,600&display=swap',
};
