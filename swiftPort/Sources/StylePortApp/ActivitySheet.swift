import SwiftUI

/// Every photo in the current and last batch, with what happened to it.
struct ActivitySheet: View {
    @EnvironmentObject private var queue: PortQueue
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                ForEach(queue.jobs) { job in
                    JobRow(job: job)
                }
            }
            .overlay {
                if queue.jobs.isEmpty {
                    ContentUnavailableView("Nothing in Progress", systemImage: "checkmark.circle")
                }
            }
            .navigationTitle("Activity")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Clear") { queue.clearFinished() }
                        .disabled(queue.jobs.allSatisfy { !$0.isFinished })
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .formSheetSizing()
    }
}
