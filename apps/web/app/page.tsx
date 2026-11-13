export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col px-5 py-8 md:px-10 md:py-14">
      <header className="flex items-center justify-between border-b border-slate-200 pb-5">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-blue-700">
            AI Service Agent
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">
            Sara
          </h1>
        </div>
        <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-600">
          ANCFZ
        </span>
      </header>

      <section className="flex flex-1 flex-col items-center justify-center py-16 text-center">
        <div className="max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
          <h2 className="text-xl font-semibold">How can I help you?</h2>
          <p className="mt-3 text-sm leading-6 text-slate-600">
            The customer chat will connect to the published Microsoft Foundry
            agent when the Foundry and conversation phases are implemented.
          </p>
          <p className="mt-5 text-xs text-slate-500">
            P0: application shell. No conversation is running yet.
          </p>
        </div>
      </section>

      <footer className="border-t border-slate-200 pt-4 text-xs text-slate-500">
        Simple, accessible business assistance
      </footer>
    </main>
  );
}
