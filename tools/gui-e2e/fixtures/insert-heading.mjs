// Fixture stimulus for the scroll-capture scenario: insert a heading while the page is being
// captured. The delay is an input to the page, not a wait for the process under test.
export const insertHeadingAfter = (page, delayMs) =>
  page.evaluate(
    ({ delay }) =>
      new Promise((resolve) =>
        globalThis.setTimeout(() => {
          const heading = globalThis.document.createElement("h2");
          heading.id = "section-running";
          heading.textContent = "在干活";
          globalThis.document.getElementById("section-slot").append(heading);
          resolve();
        }, delay),
      ),
    { delay: delayMs },
  );
