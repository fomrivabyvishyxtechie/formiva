// Respondent tokens sit in the URL path. Logs and problem responses must never carry them,
// and request logs must not carry the caller's IP address.
const TOKEN_IN_PATH = /(\/public\/v1\/forms\/)[^/?#]+/;

export function redactUrl(url: string | undefined): string | undefined {
  return url?.replace(TOKEN_IN_PATH, '$1:respondent_token');
}

export const logSerializers = {
  req(request: { method?: string; url?: string; id?: string }) {
    return { method: request.method, url: redactUrl(request.url), id: request.id };
  },
};
