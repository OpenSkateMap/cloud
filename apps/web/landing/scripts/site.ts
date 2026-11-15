if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
  const observer = new IntersectionObserver(
    (entries) =>
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("in");
        observer.unobserve(entry.target);
      }),
    { threshold: 0.15 },
  );
  document.querySelectorAll<HTMLElement>(".chapter-head, .card, .promises li, .close h2").forEach((element) => {
    element.classList.add("reveal");
    observer.observe(element);
  });
}

const hero = document.querySelector(".hero");
if (hero) new IntersectionObserver(([entry]) => hero.classList.toggle("off", !entry?.isIntersecting)).observe(hero);

// Page views go to the app's PostHog project without cookies or stored ids, through the Worker's /ph proxy, and only
// after the page has loaded, so analytics never compete with it.
addEventListener("load", () =>
  setTimeout(async () => {
    const { default: posthog } = await import("posthog-js");
    posthog.init("phc_ksR9GhRebVK7mepaLCi6iw68bZpmaPD4zTiWkHe26Ppr", {
      api_host: "/ph",
      ui_host: "https://us.posthog.com",
      cookieless_mode: "always",
      person_profiles: "never",
      disable_external_dependency_loading: true,
      advanced_disable_flags: true,
      disable_session_recording: true,
      disable_surveys: true,
      capture_heatmaps: false,
      capture_dead_clicks: false,
    });
  }),
);
