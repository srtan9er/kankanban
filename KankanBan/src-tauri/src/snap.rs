use tauri::Manager;
use serde::Serialize;
const SNAP_MIN_PX: f64 = 10.0;
const SNAP_RATIO_DIVISOR: f64 = 25.0;
fn snap_threshold(a_w: f64, b_w: f64, scale: f64) -> f64 {
    (SNAP_MIN_PX * scale).max(a_w.max(b_w) / SNAP_RATIO_DIVISOR)
}

/// 两个区间是否有重叠（容差 0，严格重叠）。
/// 这是"线段而非无限长直线"的关键：对齐左右边时要比 Y 区间，对齐上下边时要比 X 区间。
fn ranges_overlap(a0: f64, a1: f64, b0: f64, b1: f64) -> bool {
    a0 < b1 && b0 < a1
}

#[derive(Clone, Copy)]
struct NoteRect {
    id: u32,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}

impl NoteRect {
    fn right(&self) -> i32 { self.x + self.w }
    fn bottom(&self) -> i32 { self.y + self.h }
}

#[derive(Default, Clone, Copy, Serialize)]
struct SnapHint {
    left: bool,
    right: bool,
    top: bool,
    bottom: bool,
}

pub fn move_and_snap(app: &tauri::AppHandle, window: &tauri::WebviewWindow, x: f64, y: f64, finish: bool) -> Result<serde_json::Value, String> {
    if !x.is_finite() || !y.is_finite() { return Err(crate::i18n::text("native/snap.text001", &[]).into()); }
    let mut rects = Vec::new();
    let mut source = 0;
    let mut labels: Vec<_> = app.webview_windows().into_iter().collect();
    labels.sort_by(|a,b| a.0.cmp(&b.0));
    for (i, (label, other)) in labels.iter().enumerate() {
        if label == window.label() { source = i as u32; }
        if let (Ok(p), Ok(s)) = (other.outer_position(), other.outer_size()) {
            rects.push(NoteRect { id: i as u32, x: p.x, y: p.y, w: s.width as i32, h: s.height as i32 });
        }
    }
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().unwrap_or(1.0);
    let area = window.current_monitor().ok().flatten().map(|monitor| {
        let a = monitor.work_area(); (a.position.x, a.position.y, a.size.width as i32, a.size.height as i32)
    });
    let (sx, sy, hint, _) = snap_position(&rects, source, x, y, size.width as i32, size.height as i32, area, scale);
    window.set_position(tauri::PhysicalPosition::new(if finish { sx } else { x } as i32, if finish { sy } else { y } as i32)).map_err(|e| e.to_string())?;
    Ok(serde_json::to_value(hint).unwrap_or_default())
}



/// 一个吸附候选。
struct SnapCand {
    pos: f64,
    label: String,
    /// 命中时该高亮被拖便签的哪条边
    side: &'static str,
    /// 资格：平行于吸附边的那条轴上必须与对方有重叠（见 snap_position）
    eligible: bool,
    /// 该候选自己的阈值
    thr: f64,
    /// 该候选属于哪张便签；屏幕工作区边缘为 None。
    /// 用于"拐角吸附"：某一轴已经吸到某张便签后，那张便签在另一轴的候选无视资格判定。
    note_id: Option<u32>,
}

/// 单轴吸附结果。
struct AxisHit {
    pos: f64,
    label: Option<String>,
    side: Option<&'static str>,
    thr: f64,
    note_id: Option<u32>,
}

/// 单轴吸附：在候选里挑离 desired 最近的一个，要求它【有资格】且距离不超过它自己的阈值。
fn snap_axis(desired: f64, cands: &[SnapCand]) -> AxisHit {
    let mut best = desired;
    let mut best_d = f64::INFINITY;
    let mut hit: Option<(String, &'static str, f64, Option<u32>)> = None;
    for c in cands {
        if !c.eligible { continue }
        let d = (c.pos - desired).abs();
        if d <= c.thr && d < best_d {
            best_d = d;
            best = c.pos;
            hit = Some((c.label.clone(), c.side, c.thr, c.note_id));
        }
    }
    match hit {
        Some((label, side, thr, note_id)) => {
            AxisHit { pos: best, label: Some(label), side: Some(side), thr, note_id }
        }
        None => AxisHit { pos: best, label: None, side: None, thr: 0.0, note_id: None },
    }
}

/// 计算吸附位置与对齐提示。
///
/// 对 x/y 两轴分别构造候选坐标，各自取最近的一个：
///   - 我的左/上边 对齐 对方(或屏幕)的左/上边
///   - 我的左/上边 对齐 对方的右/下边（并排贴合）
///   - 我的右/下边 对齐 对方的左/上边（反向并排贴合）
///   - 我的右/下边 对齐 对方的右/下边
///
/// 【线段语义】比的是"平行于吸附边"那条轴上的重叠，不是无限长的对齐直线：
///   - 对齐左右边（改 X）→ 要求两者 Y 区间有重叠
///   - 对齐上下边（改 Y）→ 要求两者 X 区间有重叠
/// 否则一张便签的 X 只要接近，哪怕在 Y 方向相隔几百像素也会被吸过去。
/// 屏幕工作区边缘不设这条限制：屏幕边本身就是贯穿整条边的。
///
/// 注意：拖动过程中【不应用】返回的坐标，只用它对出提示；
/// 真正移动窗口是在 drag_end 里做的。
fn snap_position(
    rects: &[NoteRect],
    source_id: u32,
    desired_x: f64,
    desired_y: f64,
    w: i32,
    h: i32,
    area: Option<(i32, i32, i32, i32)>, // 工作区 (x, y, w, h)
    scale: f64,
) -> (f64, f64, SnapHint, Option<String>) {
    let (wf, hf) = (w as f64, h as f64);

    // 被拖便签【移动后】的矩形，用于"平行于吸附边的轴上必须重叠"的判断
    let (self_x0, self_x1) = (desired_x, desired_x + wf);
    let (self_y0, self_y1) = (desired_y, desired_y + hf);
    let thr_self = snap_threshold(wf, wf, scale);

    let mut xs: Vec<SnapCand> = Vec::new();
    let mut ys: Vec<SnapCand> = Vec::new();

    // 屏幕工作区边缘（用 work_area 而不是整块屏幕，免得吸到任务栏底下）
    if let Some((ax, ay, aw, ah)) = area {
        let (axf, ayf, awf, ahf) = (ax as f64, ay as f64, aw as f64, ah as f64);
        xs.push(SnapCand { pos: axf, label: crate::i18n::text("native/snap.text002", &[]).into(), side: "left", eligible: true, thr: thr_self, note_id: None });
        xs.push(SnapCand { pos: axf + awf - wf, label: crate::i18n::text("native/snap.text003", &[]).into(), side: "right", eligible: true, thr: thr_self, note_id: None });
        ys.push(SnapCand { pos: ayf, label: crate::i18n::text("native/snap.text004", &[]).into(), side: "top", eligible: true, thr: thr_self, note_id: None });
        ys.push(SnapCand { pos: ayf + ahf - hf, label: crate::i18n::text("native/snap.text005", &[]).into(), side: "bottom", eligible: true, thr: thr_self, note_id: None });
    }

    for r in rects {
        if r.id == source_id { continue }
        let tag = format!("note-{}", r.id);
        let (l, t) = (r.x as f64, r.y as f64);
        let (rt, b) = (r.right() as f64, r.bottom() as f64);
        let thr = snap_threshold(wf, r.w as f64, scale);
        let nid = Some(r.id);

        // 线段语义：对齐左右边比 Y 区间，对齐上下边比 X 区间
        let y_ov = ranges_overlap(self_y0, self_y1, t, b);
        let x_ov = ranges_overlap(self_x0, self_x1, l, rt);

        xs.push(SnapCand { pos: l,       label: crate::i18n::text("native/snap.text006", &[("arg0", format!("{}", tag))]),   side: "left",  eligible: y_ov, thr, note_id: nid });
        xs.push(SnapCand { pos: rt,      label: crate::i18n::text("native/snap.text007", &[("arg0", format!("{}", tag))]),   side: "left",  eligible: y_ov, thr, note_id: nid });
        xs.push(SnapCand { pos: l - wf,  label: crate::i18n::text("native/snap.text008", &[("arg0", format!("{}", tag))]), side: "right", eligible: y_ov, thr, note_id: nid });
        xs.push(SnapCand { pos: rt - wf, label: crate::i18n::text("native/snap.text009", &[("arg0", format!("{}", tag))]), side: "right", eligible: y_ov, thr, note_id: nid });

        ys.push(SnapCand { pos: t,       label: crate::i18n::text("native/snap.text010", &[("arg0", format!("{}", tag))]),   side: "top",    eligible: x_ov, thr, note_id: nid });
        ys.push(SnapCand { pos: b,       label: crate::i18n::text("native/snap.text011", &[("arg0", format!("{}", tag))]),   side: "top",    eligible: x_ov, thr, note_id: nid });
        ys.push(SnapCand { pos: t - hf,  label: crate::i18n::text("native/snap.text012", &[("arg0", format!("{}", tag))]), side: "bottom", eligible: x_ov, thr, note_id: nid });
        ys.push(SnapCand { pos: b - hf,  label: crate::i18n::text("native/snap.text013", &[("arg0", format!("{}", tag))]), side: "bottom", eligible: x_ov, thr, note_id: nid });
    }

    // ---- 第一遍：按正常资格各轴判定，看哪一轴先吸上 ----
    let first_x = snap_axis(desired_x, &xs);
    let first_y = snap_axis(desired_y, &ys);

    // ---- 第二遍：拐角吸附 ----
    // 若某一轴已经吸附到【某张便签】，则那张便签在【另一轴】的候选无视线段判定。
    //
    // 为什么需要：并排摆放时两者在 X 上并不重叠（严格重叠，挨着不算），
    // 于是 Y 候选恒被否掉 —— "并排之后再把上边对齐"永远做不到。
    // 放行后就能一路吸成完全对齐的矩形。上下堆叠后对齐左边同理（所以两轴都放行）。
    //
    // 安全性：能触发放行的便签，必然已经在另一轴通过过线段判定 ——
    // 也就是它本来就挨着被拖便签。远处那张便签不会因为这条而突然把人吸走。
    let bypass_x = first_y.note_id;
    let bypass_y = first_x.note_id;
    if bypass_x.is_some() {
        for c in xs.iter_mut() {
            if c.note_id.is_some() && c.note_id == bypass_x {
                c.eligible = true;
            }
        }
    }
    if bypass_y.is_some() {
        for c in ys.iter_mut() {
            if c.note_id.is_some() && c.note_id == bypass_y {
                c.eligible = true;
            }
        }
    }

    let hx = snap_axis(desired_x, &xs);
    let hy = snap_axis(desired_y, &ys);

    let mut hint = SnapHint::default();
    match hx.side {
        Some("left") => hint.left = true,
        Some("right") => hint.right = true,
        _ => {}
    }
    match hy.side {
        Some("top") => hint.top = true,
        Some("bottom") => hint.bottom = true,
        _ => {}
    }

    let desc = match (&hx.label, &hy.label) {
        (Some(a), Some(b)) => Some(format!("{a} + {b}")),
        (Some(a), None) => Some(a.clone()),
        (None, Some(b)) => Some(b.clone()),
        (None, None) => None,
    };
    let shown_thr = match (&hx.label, &hy.label) {
        (Some(_), Some(_)) => hx.thr.max(hy.thr),
        (Some(_), None) => hx.thr,
        _ => hy.thr,
    };
    let desc = desc.map(|d| crate::i18n::text("native/snap.text014", &[("arg0", format!("{}", d)), ("arg1", format!("{:.1}", shown_thr))]));

    (hx.pos, hy.pos, hint, desc)
}


#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn snaps_adjacent_edges_but_not_infinite_lines() {
        let other = NoteRect { id: 2, x: 400, y: 100, w: 200, h: 200 };
        let (x, _, hint, _) = snap_position(&[other], 1, 205.0, 120.0, 200, 200, None, 1.0);
        assert_eq!(x, 200.0); assert!(hint.right);
        let (x, y, _, _) = snap_position(&[other], 1, 205.0, 800.0, 200, 200, None, 1.0);
        assert_eq!((x, y), (205.0, 800.0));
    }
    #[test]
    fn snaps_to_monitor_work_area_with_negative_origin() {
        let (x, y, hint, _) = snap_position(&[], 1, -1915.0, 6.0, 200, 200, Some((-1920, 0, 1920, 1040)), 1.0);
        assert_eq!((x, y), (-1920.0, 0.0)); assert!(hint.left && hint.top);
    }
}
