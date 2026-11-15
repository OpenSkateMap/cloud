import { customType } from "drizzle-orm/pg-core";

export interface Coordinate {
  readonly latitude: number;
  readonly longitude: number;
}

/** Drizzle's built-in `geometry` drops the SRID, which a 4326 column rejects: this writes EWKT and reads hex EWKB. */
export const point = customType<{ data: Coordinate; driverData: string }>({
  dataType: () => "geometry(Point, 4326)",
  toDriver: ({ latitude, longitude }) => `SRID=4326;POINT(${longitude} ${latitude})`,
  fromDriver: (hex) => parsePoint(hex),
});

export const multiPolygon = customType<{ data: string }>({ dataType: () => "geometry(MultiPolygon, 4326)" });

const POINT_TYPE = 1;
const HAS_SRID = 0x20000000;

export function parsePoint(hex: string): Coordinate {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  const view = new DataView(bytes.buffer);
  const littleEndian = view.getUint8(0) === 1;
  const type = view.getUint32(1, littleEndian);
  if ((type & 0xff) !== POINT_TYPE || bytes.length < 21) throw new Error(`Not a 2D point (type ${type})`);
  const offset = type & HAS_SRID ? 9 : 5;
  return { longitude: view.getFloat64(offset, littleEndian), latitude: view.getFloat64(offset + 8, littleEndian) };
}
