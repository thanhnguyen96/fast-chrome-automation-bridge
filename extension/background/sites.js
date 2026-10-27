// Pluggable site modules injected only on matching tabs.

export const SITE_MODULES = [
  {
    name: 'google_flow',
    match: /^https:\/\/(labs|flow)\.google(\.com)?\//,
    files: ['sites/google_flow.js']
  }
];

export function matchingSiteFiles(url) {
  if (!url) return [];
  const files = [];
  for (const site of SITE_MODULES) {
    if (site.match.test(url)) files.push(...site.files);
  }
  return files;
}
