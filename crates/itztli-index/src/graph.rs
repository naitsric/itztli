//! The link graph, for drawing it.

use std::collections::{BTreeMap, HashMap};

use itztli_core::path;
use serde::Serialize;

use crate::Index;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Graph {
    pub nodes: Vec<Node>,
    /// `[from, to]`, indices into `nodes`: once per way, however many links
    /// there are.
    pub edges: Vec<[u32; 2]>,
    /// What properties call some of the edges, by name.
    pub relations: Vec<Relation>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    /// The note's path, or the bare name of one nobody has written.
    pub id: String,
    pub name: String,
    pub missing: bool,
    /// The note's `type` property.
    pub r#type: Option<String>,
    /// The note's first tag, for grouping.
    pub tag: Option<String>,
}

/// The edges a property makes: `author: "[[Ana]]"` makes one of `author`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Relation {
    pub name: String,
    /// Indices into `edges`.
    pub edges: Vec<u32>,
}

/// Where a link leads: a note, or the key of a name nobody has written.
enum To<'a> {
    Note(&'a str),
    Unwritten(String),
}

impl Index {
    /// Every note and link, or only what is within `depth` links of `around`.
    pub fn graph(&self, around: Option<(&str, usize)>, missing: bool) -> Graph {
        let mut unwritten: BTreeMap<String, &str> = BTreeMap::new();
        let mut links: Vec<(&str, To, Option<&str>)> = Vec::new();
        for (source, meta) in self.notes() {
            for link in &meta.links {
                let to = match self.resolve_link(source, link) {
                    // A note that could not be read is in nobody's graph.
                    Some(to) if to != source && self.note(to).is_some() => To::Note(to),
                    Some(_) => continue,
                    None if missing => {
                        let name = path::link_name(&link.target);
                        let key = path::key(name);
                        unwritten.entry(key.clone()).or_insert(name);
                        To::Unwritten(key)
                    }
                    None => continue,
                };
                links.push((source, to, link.relation.as_deref()));
            }
        }

        let mut ids: Vec<&str> = self.notes().map(|(p, _)| p).chain(unwritten.values().copied()).collect();
        ids.sort_unstable();
        ids.dedup();
        let at: HashMap<&str, usize> = ids.iter().enumerate().map(|(i, id)| (*id, i)).collect();
        let pairs: Vec<(usize, usize, Option<&str>)> = links
            .iter()
            .map(|(source, to, relation)| {
                let to = match to {
                    To::Note(p) => p,
                    To::Unwritten(key) => unwritten[key],
                };
                (at[source], at[to], *relation)
            })
            .collect();

        // Near is near whichever way the link goes.
        let keep: Option<Vec<bool>> = around.map(|(center, depth)| {
            let mut seen = vec![false; ids.len()];
            let Some(&center) = at.get(center) else { return seen };
            let mut near: Vec<Vec<usize>> = vec![Vec::new(); ids.len()];
            for &(a, b, _) in &pairs {
                near[a].push(b);
                near[b].push(a);
            }
            seen[center] = true;
            let mut edge = vec![center];
            for _ in 0..depth {
                edge = edge.iter().flat_map(|&n| &near[n]).copied().filter(|&n| !std::mem::replace(&mut seen[n], true)).collect();
            }
            seen
        });

        let mut nodes = Vec::new();
        let mut index = vec![u32::MAX; ids.len()];
        for (i, id) in ids.into_iter().enumerate() {
            if keep.as_ref().is_some_and(|keep| !keep[i]) {
                continue;
            }
            index[i] = nodes.len() as u32;
            let meta = self.note(id);
            nodes.push(Node {
                id: id.to_owned(),
                name: path::link_name(id).to_owned(),
                missing: meta.is_none(),
                r#type: meta.and_then(|m| m.r#type.clone()),
                tag: meta.and_then(|m| m.tags.first()).map(|t| t.name.clone()),
            });
        }
        let kept: Vec<([u32; 2], Option<&str>)> = pairs
            .into_iter()
            .map(|(a, b, relation)| ([index[a], index[b]], relation))
            .filter(|([a, b], _)| *a != u32::MAX && *b != u32::MAX)
            .collect();

        let mut edges: Vec<[u32; 2]> = kept.iter().map(|(edge, _)| *edge).collect();
        edges.sort_unstable();
        edges.dedup();
        let mut named: BTreeMap<&str, Vec<u32>> = BTreeMap::new();
        for (edge, relation) in &kept {
            if let (Some(name), Ok(i)) = (relation, edges.binary_search(edge)) {
                named.entry(name).or_default().push(i as u32);
            }
        }
        let relations = named
            .into_iter()
            .map(|(name, mut edges)| {
                edges.sort_unstable();
                edges.dedup();
                Relation { name: name.to_owned(), edges }
            })
            .collect();
        Graph { nodes, edges, relations }
    }
}

#[cfg(test)]
mod tests {
    use super::Relation;
    use crate::testing::{entry, index};

    #[test]
    fn links_count_once_per_way() {
        let i = index(&[("a.md", "[[b]] [[b]] [[a]] [[new]] ![[p.png]] #t"), ("b.md", "[[a]]"), ("c.md", ""), ("p.png", "")]);
        let all = i.graph(None, true);
        assert_eq!(
            all.nodes.iter().map(|n| (n.id.as_str(), n.missing)).collect::<Vec<_>>(),
            [("a.md", false), ("b.md", false), ("c.md", false), ("new", true)]
        );
        assert_eq!(all.nodes[0].tag.as_deref(), Some("t"));
        assert_eq!(all.edges, [[0, 1], [0, 3], [1, 0]]);
        assert!(all.relations.is_empty());
        assert_eq!(i.graph(None, false).nodes.len(), 3);
    }

    #[test]
    fn properties_name_relations_and_types() {
        let i = index(&[
            ("m.md", "---\ntype: meeting\nauthor: \"[[ana]]\"\nattendees: [\"[[ana]]\", \"[[luis]]\"]\n---\nWith [[ana]]."),
            ("ana.md", "---\ntype: person\n---\n#team"),
            ("luis.md", "#team"),
            ("x.md", "---\nreports: \"[[ana]]\"\n---\n"),
        ]);
        let g = i.graph(None, false);
        let types: Vec<(&str, Option<&str>, Option<&str>)> =
            g.nodes.iter().map(|n| (n.name.as_str(), n.r#type.as_deref(), n.tag.as_deref())).collect();
        assert_eq!(
            types,
            [
                ("ana", Some("person"), Some("team")),
                ("luis", None, Some("team")),
                ("m", Some("meeting"), None),
                ("x", None, None)
            ]
        );
        assert_eq!(g.edges, [[2, 0], [2, 1], [3, 0]]);
        let relation = |name: &str, edges: &[u32]| Relation { name: name.into(), edges: edges.to_vec() };
        assert_eq!(g.relations, [relation("attendees", &[0, 1]), relation("author", &[0]), relation("reports", &[2])]);
    }

    #[test]
    fn links_to_notes_that_could_not_be_read_are_left_out() {
        let mut i = index(&[("a.md", "[[big]] [[b]]"), ("b.md", "")]);
        i.put(entry("big.md"), None);
        let all = i.graph(None, true);
        assert_eq!(all.nodes.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(), ["a.md", "b.md"]);
        assert_eq!(all.edges, [[0, 1]]);
        assert!(i.graph(Some(("big.md", 1)), true).nodes.is_empty());
    }

    #[test]
    fn local_graphs_stop_at_their_depth() {
        let i = index(&[
            ("a.md", "[[b]]"),
            ("b.md", "[[c]]"),
            ("c.md", "[[d]]"),
            ("d.md", ""),
            ("e.md", "---\nup: \"[[a]]\"\n---\n"),
        ]);
        let ids = |depth| i.graph(Some(("a.md", depth)), false).nodes.into_iter().map(|n| n.id).collect::<Vec<_>>();
        assert_eq!(ids(1), ["a.md", "b.md", "e.md"], "links to it count too");
        assert_eq!(ids(2), ["a.md", "b.md", "c.md", "e.md"]);
        let near = i.graph(Some(("a.md", 1)), false);
        assert_eq!((near.edges, near.relations[0].edges.clone()), (vec![[0, 1], [2, 0]], vec![1]));
        assert!(i.graph(Some(("p.png", 1)), false).nodes.is_empty());
    }
}
