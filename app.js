function filt(inp,listSel){var q=inp.value.trim().toLowerCase();var n=0;var so=document.body.classList.contains('onlystar');
document.querySelectorAll(listSel+' .e').forEach(function(e){var hit=(!q||e.textContent.toLowerCase().indexOf(q)>=0)&&(!so||e.classList.contains('st'));e.classList.toggle('hide',!hit);if(hit)n++;});
var c=document.getElementById('cnt');if(c)c.textContent=(q||so)?('匹配 '+n+' 条'):c.dataset.all;}
function stfilter(cb){document.body.classList.toggle('onlystar',cb.checked);var q=document.querySelector('input.q');if(q)filt(q,'#lst');}
document.addEventListener('keydown',function(ev){if(ev.key==='/'&&!/INPUT|TEXTAREA/.test(document.activeElement.tagName)){ev.preventDefault();var q=document.querySelector('input.q');if(q)q.focus();}});
(function(){var links={};document.querySelectorAll('.toc a').forEach(function(a){links[a.getAttribute('href').slice(1)]=a;});
var heads=document.querySelectorAll('#lst h2.topic[id],#lst h3.sec[id]');
if(!('IntersectionObserver' in window)||!heads.length)return;
var ob=new IntersectionObserver(function(es){es.forEach(function(en){if(en.isIntersecting){document.querySelectorAll('.toc a.on').forEach(function(x){x.classList.remove('on');});var l=links[en.target.id];if(l)l.classList.add('on');}});},{rootMargin:'-70px 0px -75% 0px'});
heads.forEach(function(h){ob.observe(h);});})();
function gsearch(inp){var q=inp.value.trim().toLowerCase();var box=document.getElementById('gres');var c=document.getElementById('gcnt');
if(q.length<2){box.innerHTML='';c.textContent='';return;}
if(!window.IDX){c.textContent='正在载入索引…';fetch('entries.json').then(function(r){return r.json()}).then(function(j){window.IDX=j;gsearch(inp)});return;}
var out=[],i,e;for(i=0;i<window.IDX.length&&out.length<120;i++){e=window.IDX[i];if(e.n.toLowerCase().indexOf(q)>=0||e.d.toLowerCase().indexOf(q)>=0)out.push(e);}
c.textContent='找到 '+out.length+(out.length>=120?'＋':'')+' 条';
box.innerHTML=out.map(function(e){return '<div class="e'+(e.star?' st':'')+'">'+(e.star?'<span class="star">★</span> ':'')+'<a class="n" target="_blank" rel="noopener" href="'+e.u+'">'+e.n+'</a><span class="d">'+e.c+' · '+e.s+' — '+e.d+'</span></div>'}).join('');}