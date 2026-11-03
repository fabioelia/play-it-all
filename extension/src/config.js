// Where the community catalog lives. Viewers read it straight from GitHub;
// contributors submit through issues and pull requests on the same repository.
export const CATALOG_REPO = 'fabioelia/play-it-all';
export const CATALOG_BRANCH = 'main';
export const DEFAULT_CATALOG = `https://raw.githubusercontent.com/${CATALOG_REPO}/${CATALOG_BRANCH}/catalog/`;
export const ISSUE_TEMPLATE = 'submit-to-catalog.yml';
// GitHub rejects very long URLs; longer submissions go via the clipboard.
export const MAX_ISSUE_URL = 7500;
