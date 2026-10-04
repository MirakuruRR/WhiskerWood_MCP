// WBP_<Мод>Overlay — свой виджет оверлея для ряда HUD. Пара к HudOverlay.lm.tpl:
// тот создаёт этот виджет через create_widget и возвращает его в ряд игры каждый кадр.
// Файл: <кит>/Content/Mods/<Мод>/WBP_<Мод>Overlay.lm.
//
// Наследоваться от игрового виджета нельзя: Loom даёт любому виджет-Blueprint корневой
// CanvasPanel Loom_Canvas, у наследника он перекрывает дерево родителя — виджет выходит
// пустым и нулевого размера, а check и сборка при этом проходят. Поэтому оверлей — свой
// UserWidget, а игровые виджеты создаются отдельно, через create_widget.
//
// Размер оверлея задаёт слот в родительском канвасе (SetAutoSize в HudOverlay), а не кисть:
// SetDesiredSizeOverride на иконках не действует, масштаб задают SetRenderScale.

blueprint WBP_<Мод>Overlay : UserWidget at /Game/Mods/<Мод>/WBP_<Мод>Overlay

// виджет без `at x y` становится корнем дерева и может быть только один
widget Box: HorizontalBox {
    widget Label: TextBlock(Text: "<Мод>") slot(Padding: Margin(Left: 6, Right: 6), VerticalAlignment: EVerticalAlignment.VAlign_Center)
}
