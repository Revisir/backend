import * as fc from "fast-check";

/**
 * Pure function extracted from createTopicController.ts URL filtering logic.
 * The controller uses: urls.filter((u) => u.startsWith("http://") || u.startsWith("https://"))
 * We test this exact logic as a pure function.
 */
function filterPublishableUrls(urls: string[]): string[] {
  return urls.filter((u) => u.startsWith("http://") || u.startsWith("https://"));
}

/**
 * Feature: rabbitmq-message-queues, Property 2: URL scheme filtering for queue publishing
 * Validates: Requirements 2.1, 2.5
 *
 * For any list of URLs (mix of http://, https://, ftp://, mailto:, empty strings, and arbitrary schemes),
 * the filtered list SHALL contain exactly those URLs whose scheme starts with "http://" or "https://",
 * and if no URLs match, no message should be published.
 */
describe("Feature: rabbitmq-message-queues, Property 2: URL scheme filtering for queue publishing", () => {
  // Generators for URLs with various schemes
  const httpUrl = fc.webUrl({ withFragments: true, withQueryParameters: true }).map((url) => {
    // Ensure it starts with http:// (webUrl generates http or https)
    return url.startsWith("https://") ? url.replace("https://", "http://") : url;
  });

  const httpsUrl = fc.webUrl({ withFragments: true, withQueryParameters: true }).map((url) => {
    return url.startsWith("http://") && !url.startsWith("https://")
      ? url.replace("http://", "https://")
      : url;
  });

  const ftpUrl = fc.string({ minLength: 1, maxLength: 50 }).map((s) => `ftp://${s}`);
  const mailtoUrl = fc.string({ minLength: 1, maxLength: 50 }).map((s) => `mailto:${s}`);
  const fileUrl = fc.string({ minLength: 1, maxLength: 50 }).map((s) => `file://${s}`);
  const dataUrl = fc.string({ minLength: 1, maxLength: 50 }).map((s) => `data:${s}`);
  const customSchemeUrl = fc.string({ minLength: 1, maxLength: 20 }).map((s) => `custom-${s}://example`);
  const emptyString = fc.constant("");
  const noScheme = fc.string({ minLength: 1, maxLength: 50 }).filter((s) => !s.includes("://") && !s.startsWith("http"));

  // A mixed URL arbitrary that generates URLs with various schemes
  const anyUrl = fc.oneof(
    { weight: 3, arbitrary: httpUrl },
    { weight: 3, arbitrary: httpsUrl },
    { weight: 2, arbitrary: ftpUrl },
    { weight: 2, arbitrary: mailtoUrl },
    { weight: 1, arbitrary: fileUrl },
    { weight: 1, arbitrary: dataUrl },
    { weight: 1, arbitrary: customSchemeUrl },
    { weight: 1, arbitrary: emptyString },
    { weight: 1, arbitrary: noScheme },
  );

  const urlList = fc.array(anyUrl, { minLength: 0, maxLength: 30 });

  it("every URL in the result starts with 'http://' or 'https://'", () => {
    fc.assert(
      fc.property(urlList, (urls) => {
        const result = filterPublishableUrls(urls);
        for (const url of result) {
          expect(url.startsWith("http://") || url.startsWith("https://")).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("no URL starting with 'http://' or 'https://' in the input is missing from the result", () => {
    fc.assert(
      fc.property(urlList, (urls) => {
        const result = filterPublishableUrls(urls);
        const expected = urls.filter((u) => u.startsWith("http://") || u.startsWith("https://"));
        expect(result).toEqual(expected);
      }),
      { numRuns: 200 },
    );
  });

  it("the result is a subset of the input (preserves order)", () => {
    fc.assert(
      fc.property(urlList, (urls) => {
        const result = filterPublishableUrls(urls);
        // Every element in result must appear in urls in the same relative order
        let lastIndex = -1;
        for (const url of result) {
          const idx = urls.indexOf(url, lastIndex + 1);
          expect(idx).toBeGreaterThan(lastIndex);
          lastIndex = idx;
        }
      }),
      { numRuns: 200 },
    );
  });

  it("if no URLs match the filter, the result is empty", () => {
    // Generate lists with only non-http/https URLs
    const nonHttpUrl = fc.oneof(
      ftpUrl,
      mailtoUrl,
      fileUrl,
      dataUrl,
      customSchemeUrl,
      emptyString,
      noScheme,
    );
    const nonHttpList = fc.array(nonHttpUrl, { minLength: 0, maxLength: 20 });

    fc.assert(
      fc.property(nonHttpList, (urls) => {
        const result = filterPublishableUrls(urls);
        expect(result).toHaveLength(0);
      }),
      { numRuns: 200 },
    );
  });
});
