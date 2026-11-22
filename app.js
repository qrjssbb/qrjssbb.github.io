function filt(inp,listSel){var q=inp.value.trim().toLowerCase();var n=0;
document.querySelectorAll(listSel+' .e').forEach(function(e){var hit=!q||e.textContent.toLowerCase().indexOf(q)>=0;e.classList.toggle('hide',!hit);if(hit)n++;});
var c=document.getElementById('cnt');if(c)c.textContent=q?('匹配 '+n+' 条'):c.dataset.all;}
function gsearch(inp){var q=inp.value.trim().toLowerCase();var box=document.getElementById('gres');var c=document.getElementById('gcnt');
if(q.length<2){box.innerHTML='';c.textContent='';return;}
if(!window.IDX){c.textContent='正在载入索引…';fetch('entries.json').then(function(r){return r.json()}).then(function(j){window.IDX=j;gsearch(inp)});return;}
var out=[],i,e;for(i=0;i<window.IDX.length&&out.length<120;i++){e=window.IDX[i];if(e.n.toLowerCase().indexOf(q)>=0||e.d.toLowerCase().indexOf(q)>=0)out.push(e);}
c.textContent='找到 '+out.length+(out.length>=120?'＋':'')+' 条';
box.innerHTML=out.map(function(e){return '<div class="e">'+(e.star?'<span class="star">⭐</span> ':'')+'<a class="n" target="_blank" rel="noopener" href="'+e.u+'">'+e.n+'</a><div class="d">'+e.c+' · '+e.s+' — '+e.d+'</div></div>'}).join('');}