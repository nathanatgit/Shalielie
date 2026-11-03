import SwiftUI
import UIKit

private struct ReadableWidth: ViewModifier {
    let maxWidth: CGFloat
    @State private var width: CGFloat = 0

    func body(content: Content) -> some View {
        let margin = (width - maxWidth) / 2
        // Below the limit, keep the system's inset grouped margins: a zero margin would
        // stretch rows edge to edge.
        Group {
            if margin > 0 {
                content.contentMargins(.horizontal, margin, for: .scrollContent)
            } else {
                content
            }
        }
        .background {
            GeometryReader { geometry in
                Color.clear
                    .onAppear { width = geometry.size.width }
                    .onChange(of: geometry.size.width) { _, new in width = new }
            }
        }
    }
}

/// A localized string for places that need a String rather than a view's LocalizedStringKey.
func L(_ key: String.LocalizationValue) -> String { String(localized: key) }

extension View {

    /// Keep a list or form at a comfortable reading width on iPad and in landscape.
    func readableWidth(_ maxWidth: CGFloat = 720) -> some View {
        modifier(ReadableWidth(maxWidth: maxWidth))
    }

    /// A centred form sheet on iPad (iOS 18+); iPhone is unchanged.
    @ViewBuilder
    func formSheetSizing() -> some View {
        if #available(iOS 18.0, *) {
            self.presentationSizing(.form)
        } else {
            self
        }
    }

    /// A floating bar of controls: see-through glass like the rest of the immersive grid, but it
    /// takes every tap on it, so a tap between its buttons never reaches the photos behind.
    func floatingBar() -> some View {
        floatingGlass()
            .contentShape(Capsule())
            .onTapGesture {}
    }

    /// Photos-style bars over a photo grid: no solid bar, the photos run underneath, and on
    /// iOS 26 only a soft fade sits behind the title and buttons.
    @ViewBuilder
    func immersiveBars() -> some View {
        let bars = self.toolbarBackground(.hidden, for: .navigationBar)
        if #available(iOS 26.0, *) {
            bars.scrollEdgeEffectStyle(.soft, for: .all)
        } else {
            bars
        }
    }

    /// Use the system's Liquid Glass on iOS 26+, with material fallbacks on older devices.
    @ViewBuilder
    func floatingGlass() -> some View {
        if #available(iOS 26.0, *) {
            self.glassEffect(.regular.interactive(), in: Capsule())
        } else {
            self.background(.regularMaterial, in: Capsule())
        }
    }

    @ViewBuilder
    func modernProminentButton() -> some View {
        if #available(iOS 26.0, *) {
            self.buttonStyle(.glassProminent)
        } else {
            self.buttonStyle(.borderedProminent)
        }
    }

    @ViewBuilder
    func modernTabBar() -> some View {
        if #available(iOS 26.0, *) {
            self.tabBarMinimizeBehavior(.onScrollDown)
        } else {
            self
        }
    }
}
