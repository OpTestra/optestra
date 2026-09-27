// Layout only: every colour, font and spacing value comes from the tokens.

export const STYLES = `
*{box-sizing:border-box}
body{margin:0;background:var(--c-background);color:var(--c-text);font:var(--font-size)/var(--line-height) var(--font-body)}
a{color:var(--c-accent)}
a:focus-visible,summary:focus-visible,input:focus-visible,select:focus-visible,[tabindex]:focus-visible{outline:2px solid var(--c-accent);outline-offset:2px}
code,pre,kbd{font-family:var(--font-mono);font-size:var(--font-small)}
code,kbd{background:var(--c-code);padding:0 var(--s-xs);border-radius:var(--radius)}
pre{background:var(--c-code);padding:var(--s-sm) var(--s-md);border-radius:var(--radius);overflow-x:auto;white-space:pre-wrap;word-break:break-word}
h1,h2,h3,h4{line-height:1.25;margin:0 0 var(--s-sm)}
h1{font-size:1.5em}h2{font-size:1.2em;margin-top:var(--s-xl)}h3{font-size:1em;display:inline}h4{font-size:.95em;margin-top:var(--s-lg)}
.skip{position:absolute;left:-9999px}.skip:focus{left:var(--s-md);top:var(--s-md);background:var(--c-background);padding:var(--s-sm)}
header,main,footer{max-width:var(--max-width);margin:0 auto;padding:0 var(--s-lg)}
header{padding-top:var(--s-lg);padding-bottom:var(--s-md);border-bottom:1px solid var(--c-border)}
footer{color:var(--c-muted);font-size:var(--font-small);padding-top:var(--s-xl);padding-bottom:var(--s-xl)}
.muted{color:var(--c-muted)}
.meta{color:var(--c-muted);font-size:var(--font-small)}
.meta span+span::before{content:" · "}
.tiles{display:flex;flex-wrap:wrap;gap:var(--s-sm);list-style:none;padding:0;margin:var(--s-md) 0}
.tiles li{border:1px solid var(--c-border);border-radius:var(--radius);padding:var(--s-sm) var(--s-md);min-width:7em;background:var(--c-surface)}
.tiles strong{display:block;font-size:1.4em}
.facts{display:grid;grid-template-columns:max-content 1fr;gap:var(--s-xs) var(--s-lg);margin:0}
.facts dt{color:var(--c-muted)}.facts dd{margin:0}
.badge{display:inline-block;border-radius:var(--radius);padding:0 var(--s-sm);font-size:var(--font-small);font-weight:600;white-space:nowrap}
.v-passed{color:var(--c-passed);background:var(--c-passed-bg)}
.v-healed{color:var(--c-healed);background:var(--c-healed-bg)}
.v-failed{color:var(--c-failed);background:var(--c-failed-bg)}
.v-flaky{color:var(--c-flaky);background:var(--c-flaky-bg)}
.v-blocked,.v-skipped,.v-none{color:var(--c-blocked);background:var(--c-blocked-bg)}
.v-warned,.v-warn{color:var(--c-warn);background:var(--c-warn-bg)}
.banner{border-radius:var(--radius);padding:var(--s-md);margin:var(--s-md) 0}
.card{border:1px solid var(--c-border);border-radius:var(--radius);padding:var(--s-md);margin:var(--s-md) 0;background:var(--c-surface)}
.headline{font-size:1.1em;font-weight:600;margin:0 0 var(--s-sm)}
figure{margin:var(--s-sm) 0}
figure img{width:min(100%,640px);height:auto;max-height:400px;object-fit:contain;object-position:left top;border:1px solid var(--c-border);border-radius:var(--radius);background:var(--c-background)}
figcaption{color:var(--c-muted);font-size:var(--font-small)}
.shots{display:flex;gap:var(--s-xs)}
.shots img{max-width:120px;max-height:80px;border:1px solid var(--c-border);border-radius:var(--radius)}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:var(--font-small)}
th,td{text-align:left;vertical-align:top;padding:var(--s-xs) var(--s-sm);border-bottom:1px solid var(--c-border)}
th{color:var(--c-muted);font-weight:600}
details{margin:var(--s-sm) 0}
summary{cursor:pointer}
article.test{border:1px solid var(--c-border);border-radius:var(--radius);margin:var(--s-sm) 0;background:var(--c-background)}
article.test>details{margin:0}
article.test>details>summary{padding:var(--s-sm) var(--s-md);display:flex;flex-wrap:wrap;gap:var(--s-sm);align-items:baseline}
article.test>details>div{padding:0 var(--s-md) var(--s-md);border-top:1px solid var(--c-border)}
.attempt{border-left:3px solid var(--c-border);padding-left:var(--s-md)}
.expected-actual{display:grid;grid-template-columns:max-content 1fr;gap:0 var(--s-md);margin:var(--s-xs) 0}
.expected-actual dt{color:var(--c-muted)}.expected-actual dd{margin:0}
.filters{display:flex;flex-wrap:wrap;gap:var(--s-md);align-items:end;margin:var(--s-md) 0}
.filters label{display:flex;flex-direction:column;font-size:var(--font-small);color:var(--c-muted)}
.filters input,.filters select{font:inherit;color:var(--c-text);background:var(--c-background);border:1px solid var(--c-border);border-radius:var(--radius);padding:var(--s-xs) var(--s-sm)}
ul.plain{list-style:none;padding:0}
[hidden]{display:none !important}
@media print{details{display:block}summary{list-style:none}}
`;
