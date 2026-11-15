// Does this client want Markdown rather than HTML? Media ranges and weights follow RFC 9110 §12.5.1.
const markdownType = "text/markdown";
const qvalue = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;

type Range = { type: string; quality: number };

function parse(accept: string): Range[] {
  return accept.split(",").flatMap((member) => {
    const [rawType = "", ...parameters] = member.split(";");
    const type = rawType.trim().toLowerCase();
    if (type === "") return [];
    const weight = parameters.map((parameter) => parameter.split("=")).find(([name = ""]) => name.trim().toLowerCase() === "q")?.[1]?.trim();
    // A malformed weight makes the range unusable rather than silently maximal.
    const quality = weight === undefined ? 1 : qvalue.test(weight) ? Number(weight) : 0;
    return [{ type, quality }];
  });
}

const qualityOf = (ranges: readonly Range[], type: string) => {
  const family = `${type.slice(0, type.indexOf("/"))}/*`;
  return [type, family, "*/*"].map((candidate) => ranges.find((range) => range.type === candidate)).find(Boolean)?.quality ?? 0;
};

/** True when the client names `text/markdown`, weighted at least as high as HTML; a bare `*\/*` keeps getting HTML. */
export function prefersMarkdown(accept: string | null) {
  if (accept === null || !/text\/markdown/i.test(accept)) return false;
  const ranges = parse(accept);
  const markdown = ranges.find((range) => range.type === markdownType)?.quality ?? 0;
  return markdown > 0 && markdown >= qualityOf(ranges, "text/html");
}
