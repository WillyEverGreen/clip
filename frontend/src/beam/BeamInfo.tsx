import faq from './beamFaq.json'

/**
 * Plain text below the tool so search engines (and curious people) can see what Beam is.
 * The questions come from beamFaq.json, which the build also turns into this page's FAQ markup.
 */
export default function BeamInfo() {
  return (
    <section className="beam-info" aria-labelledby="beam-info-title">
      <h2 id="beam-info-title">How Clip Beam works</h2>
      <ol className="beam-info-steps">
        <li><strong>Pick your files.</strong> Drop them in, and you get a 6-digit PIN and a link.</li>
        <li><strong>Share the PIN.</strong> Or invite people nearby from the radar, no PIN needed.</li>
        <li><strong>They accept.</strong> The file goes straight from your browser to theirs, encrypted, and is checked when it arrives.</li>
      </ol>
      <h2>Questions</h2>
      {faq.map((item) => (
        <details key={item.q} className="beam-info-q">
          <summary>{item.q}</summary>
          <p>{item.a}</p>
        </details>
      ))}
    </section>
  )
}
