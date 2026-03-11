/**
 * IMCore Private Framework Headers (class-dumped)
 * Minimal subset needed for typing indicators on macOS 13+
 *
 * These are private Apple APIs — they can break with macOS updates.
 * SIP must be disabled for dylib injection into Messages.app.
 */

#import <Foundation/Foundation.h>

@interface IMChat : NSObject
@property (nonatomic, readonly) NSString *guid;
@property (nonatomic, readonly) NSString *chatIdentifier;
@property (nonatomic, readonly) NSString *displayName;
- (void)setLocalUserIsTyping:(BOOL)typing;
@end

@interface IMChatRegistry : NSObject
+ (instancetype)sharedInstance;
- (IMChat *)existingChatWithGUID:(NSString *)guid;
- (IMChat *)existingChatWithChatIdentifier:(NSString *)identifier;
- (NSArray<IMChat *> *)allExistingChats;
@end

@interface IMDaemonController : NSObject
+ (instancetype)sharedController;
- (void)connectToDaemon;
- (BOOL)isConnected;
@end
