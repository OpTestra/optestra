// Progressive enhancement only: filters, search and opening a linked test.
// The report is complete without it. It reads the DOM, never embedded data.

export const SCRIPT = `(function(){
var form=document.getElementById("filters");
var tests=Array.prototype.slice.call(document.querySelectorAll("article.test"));
function openHash(){
  var id=decodeURIComponent(location.hash.slice(1));
  var el=id&&document.getElementById(id);
  if(!el)return;
  var d=el.closest("details")||el.querySelector("details");
  while(d){d.open=true;d=d.parentElement&&d.parentElement.closest("details");}
}
window.addEventListener("hashchange",openHash);
openHash();
if(!form)return;
form.hidden=false;
var verdict=document.getElementById("f-verdict"),tag=document.getElementById("f-tag"),search=document.getElementById("f-search"),count=document.getElementById("f-count");
function apply(){
  var v=verdict.value,t=tag?tag.value:"",q=search.value.trim().toLowerCase(),shown=0;
  tests.forEach(function(a){
    var tags=JSON.parse(a.getAttribute("data-tags")||"[]");
    var ok=(!v||a.getAttribute("data-verdict")===v)&&(!t||tags.indexOf(t)>=0)&&(!q||(a.getAttribute("data-search")||"").indexOf(q)>=0);
    a.hidden=!ok;if(ok)shown++;
  });
  count.textContent=shown+" of "+tests.length+" tests shown";
}
form.addEventListener("input",apply);
form.addEventListener("change",apply);
form.addEventListener("submit",function(e){e.preventDefault();});
apply();
})();`;
