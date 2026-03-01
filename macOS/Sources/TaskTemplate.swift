import Foundation

struct TaskTemplate {
    let name: String
    let content: String
    let usesExisting: Bool

    init(name: String, content: String, usesExisting: Bool = false) {
        self.name = name
        self.content = content
        self.usesExisting = usesExisting
    }
}
