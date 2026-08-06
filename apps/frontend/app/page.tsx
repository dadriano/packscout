const foundationItems = [
  { label: "Next.js 16", detail: "App Router" },
  { label: "React 19", detail: "Interface layer" },
  { label: "Tailwind", detail: "Design tokens" },
];

function CompassMark() {
  return (
    <svg
      aria-hidden="true"
      className="h-8 w-8"
      viewBox="0 0 32 32"
      fill="none"
    >
      <circle cx="16" cy="16" r="13.25" stroke="currentColor" strokeWidth="1.5" />
      <path d="m20.8 10.1-3 7.7-7.7 3 3-7.7 7.7-3Z" fill="currentColor" />
      <circle cx="16" cy="16" r="1.5" fill="#f3efe4" />
    </svg>
  );
}

export default function HomePage() {
  return (
    <main className="relative min-h-screen overflow-hidden px-5 py-5 sm:px-8 sm:py-7 lg:px-12 lg:py-9">
      <div className="topography pointer-events-none absolute inset-0" aria-hidden="true" />

      <div className="relative mx-auto flex min-h-[calc(100vh-2.5rem)] max-w-[1480px] flex-col border border-line bg-canvas/80 sm:min-h-[calc(100vh-3.5rem)]">
        <header className="flex items-center justify-between border-b border-line px-5 py-4 sm:px-8">
          <div className="flex items-center gap-3 text-pine">
            <CompassMark />
            <span className="text-[0.82rem] font-semibold uppercase tracking-[0.24em]">
              Packscout
            </span>
          </div>
          <div className="flex items-center gap-2 font-mono text-[0.64rem] uppercase tracking-[0.14em] text-pine sm:text-[0.7rem]">
            <span className="signal-dot h-2 w-2 rounded-full bg-trail" aria-hidden="true" />
            Basecamp online
          </div>
        </header>

        <div className="grid flex-1 lg:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]">
          <section className="flex flex-col justify-center px-5 py-16 sm:px-10 sm:py-20 lg:px-16 xl:px-24">
            <p className="mb-7 font-mono text-[0.68rem] uppercase tracking-[0.22em] text-trail">
              Field note 001 · Foundation
            </p>
            <h1 className="max-w-4xl font-display text-[clamp(3.8rem,8vw,8.5rem)] leading-[0.84] tracking-[-0.055em] text-ink">
              The trail
              <span className="block italic text-pine">starts here.</span>
            </h1>
            <p className="mt-9 max-w-xl text-base leading-7 text-ink/70 sm:text-lg sm:leading-8">
              Packscout&apos;s basecamp is in place. We&apos;re mapping the first routes now,
              with the public experience and its field tools coming next.
            </p>

            <div
              className="mt-12 flex items-center gap-4"
              role="progressbar"
              aria-label="Initial build progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={28}
            >
              <div className="h-1.5 w-40 overflow-hidden rounded-full bg-ink/10 sm:w-56">
                <div className="h-full w-[28%] rounded-full bg-trail" />
              </div>
              <span className="font-mono text-[0.68rem] uppercase tracking-[0.16em] text-ink/55">
                First mile
              </span>
            </div>
          </section>

          <aside className="flex items-center border-t border-line bg-pine px-5 py-12 text-canvas sm:px-10 lg:border-l lg:border-t-0 lg:px-14">
            <div className="field-note relative w-full overflow-hidden bg-paper px-6 py-7 text-ink shadow-field sm:px-8 sm:py-9 lg:-rotate-1">
              <div className="relative">
                <div className="flex items-start justify-between gap-5 border-b border-ink/15 pb-6">
                  <div>
                    <p className="font-mono text-[0.64rem] uppercase tracking-[0.18em] text-trail">
                      Trail ledger
                    </p>
                    <h2 className="mt-2 font-display text-3xl tracking-[-0.03em]">
                      Packscout base
                    </h2>
                  </div>
                  <span className="border border-ink/20 px-2 py-1 font-mono text-[0.6rem] uppercase tracking-[0.14em]">
                    v0.1
                  </span>
                </div>

                <dl className="mt-3">
                  {foundationItems.map((item, index) => (
                    <div
                      className="grid grid-cols-[28px_1fr_auto] items-center gap-3 border-b border-ink/10 py-4"
                      key={item.label}
                    >
                      <dt className="font-mono text-[0.62rem] text-ink/45">
                        {String(index + 1).padStart(2, "0")}
                      </dt>
                      <dd className="text-sm font-semibold">{item.label}</dd>
                      <dd className="text-right font-mono text-[0.62rem] uppercase tracking-[0.1em] text-ink/50">
                        {item.detail}
                      </dd>
                    </div>
                  ))}
                </dl>

                <div className="mt-8 flex items-end justify-between gap-6">
                  <p className="max-w-[16rem] font-display text-xl italic leading-6 text-pine">
                    Built light. Ready for what comes next.
                  </p>
                  <div className="flex h-14 w-14 shrink-0 rotate-6 items-center justify-center rounded-full border border-trail text-trail">
                    <span className="font-mono text-[0.58rem] font-bold uppercase tracking-[0.08em]">
                      Ready
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </aside>
        </div>

        <footer className="flex flex-col gap-2 border-t border-line px-5 py-4 font-mono text-[0.6rem] uppercase tracking-[0.14em] text-ink/50 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <span>Packscout · Initial framework</span>
          <span>Coordinates 00° 00′ · Heading forward</span>
        </footer>
      </div>
    </main>
  );
}
