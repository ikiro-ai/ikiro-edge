// swift-tools-version:5.9

import PackageDescription

let package = Package(
    name: "TypingHelper",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(name: "typing-helper", targets: ["TypingHelper"])
    ],
    targets: [
        .executableTarget(
            name: "TypingHelper",
            dependencies: [],
            cSettings: [
                .headerSearchPath(".")
            ],
            linkerSettings: [
                // IMCore is loaded dynamically via dlopen at runtime,
                // so no link-time dependency needed. This builds without SIP disabled.
            ]
        )
    ]
)
