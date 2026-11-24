//! The link graph, for drawing it.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use itztli_core::path;
use serde::Serialize;

use crate::Index;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Graph {
    pub nodes: Vec<Node>,
    /// Pairs of indices into `nodes`, each once whichever way it links.
    pub edges: Vec<[u32; 2]>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    /// The note's path, or the bare name of one nobody has written.
    pub id: String,
    pub name: String,
    pub missing: bool,
    /// The note's first tag, for grouping.
    pub tag: Option<String>,
}

impl Index {
    /// Every note and link, or only what is within `depth` links of `around`.
    pub fn graph(&self, around: Option<(&str, usize)>, missing: bool) -> Graph {
        let mut links: BTreeSet<(String, String)> = BTreeSet::new();
        let mut unwritten: BTreeMap<String, String> = BTreeMap::new();
        for (source, meta) in self.notes() {
            for link in &meta.links {
                let to = match self.resolve_link(source, link) {
                    Some(to) if to != source && path::is_note(to) => to.to_owned(),
                    Some(_) => continue,
                    None if missing => {
                        let name = path::link_name(&link.target);
                        unwritten.entry(path::key(name)).or_insert_with(|| name.to_owned()).clone()
                    }
                    None => continue,
                };
                let source = source.to_owned();
                links.insert(if source < to { (source, to) } else { (to, source) });
            }
        }

        let keep: Option<BTreeSet<&str>> = around.map(|(center, depth)| {
            let mut near: HashMap<&str, Vec<&str>> = HashMap::new();
            for (a, b) in &links {
                near.entry(a).or_default().push(b);
                near.entry(b).or_default().push(a);
            }
            let mut seen = BTreeSet::from([center]);
            let mut edge = vec![center];
            for _ in 0..depth {
                edge = edge.iter().flat_map(|p| near.get(p).into_iter().flatten().copied()).filter(|p| seen.insert(p)).collect();
            }
            seen
        });

        let mut ids: BTreeSet<&str> = self.notes().map(|(p, _)| p).collect();
        ids.extend(unwritten.values().map(String::as_str));
        if let Some(keep) = &keep {
            ids.retain(|id| keep.contains(id));
        }
        let at: HashMap<&str, u32> = ids.iter().enumerate().map(|(i, id)| (*id, i as u32)).collect();
        let edges = links.iter().filter_map(|(a, b)| Some([*at.get(a.as_str())?, *at.get(b.as_str())?])).collect();
        let nodes = ids
            .into_iter()
            .map(|id| {
                let meta = self.note(id);
                Node {
                    id: id.to_owned(),
                    name: path::link_name(id).to_owned(),
                    missing: meta.is_none(),
                    tag: meta.and_then(|m| m.tags.first()).map(|t| t.name.clone()),
                }
            })
            .collect();
        Graph { nodes, edges }
    }
}

#[cfg(test)]
mod tests {
    use crate::testing::index;

    #[test]
    fn links_count_once_whichever_way() {
        let i = index(&[("a.md", "[[b]] [[b]] [[a]] [[new]] ![[p.png]] #t"), ("b.md", "[[a]]"), ("c.md", ""), ("p.png", "")]);
        let all = i.graph(None, true);
        assert_eq!(
            all.nodes.iter().map(|n| (n.id.as_str(), n.missing)).collect::<Vec<_>>(),
            [("a.md", false), ("b.md", false), ("c.md", false), ("new", true)]
        );
        assert_eq!(all.nodes[0].tag.as_deref(), Some("t"));
        assert_eq!(all.edges, [[0, 1], [0, 3]]);
        assert_eq!(i.graph(None, false).nodes.len(), 3);
    }

    #[test]
    fn local_graphs_stop_at_their_depth() {
        let i = index(&[("a.md", "[[b]]"), ("b.md", "[[c]]"), ("c.md", "[[d]]"), ("d.md", "")]);
        let ids = |depth| i.graph(Some(("a.md", depth)), false).nodes.into_iter().map(|n| n.id).collect::<Vec<_>>();
        assert_eq!(ids(1), ["a.md", "b.md"]);
        assert_eq!(ids(2), ["a.md", "b.md", "c.md"]);
    }
}
