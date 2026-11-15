export const site = {
  name: "OpenSkateMap",
  origin: "https://openskatemap.app",
  contact: "hey@openskatemap.app",
  photos: "https://images.openskatemap.app",
  api: "https://api.openskatemap.app",
  github: "https://github.com/OpenSkateMap",
  testFlight: "https://testflight.apple.com/join/3pFyeYVS",
  appIDs: ["MD55Y22MQS.com.ertembiyik.openskatemap", "MD55Y22MQS.com.ertembiyik.openskatemap.dev"],
} as const;

export const contactText = (contact: string) => `[${contact}](mailto:${contact})`;
