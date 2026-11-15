import type { APIRoute, GetStaticPaths } from "astro";
import { faceFiles } from "../../data/faces";

export const getStaticPaths = (() => Object.values(faceFiles).map(({ name, bytes }) => ({ params: { file: name }, props: { bytes } }))) satisfies GetStaticPaths;

export const GET: APIRoute<{ bytes: Buffer }> = ({ props }) => new Response(new Uint8Array(props.bytes), { headers: { "Content-Type": "image/webp" } });
